import { assembleVaultContext } from "./context/context-assembler";
import type {
	VaultRetrievalInput,
	VaultRetrievalResult,
} from "./context/vault-retrieval";
import type { ProviderFacade } from "./provider/provider-facade";
import type { AskEvent } from "./provider/types";
import {
	auditProviderEgress,
} from "./privacy/provider-egress-gate";
import type { ProviderEgressAuditAppendInput } from "./privacy/provider-egress-audit-store";
import type {
	TalosSchemaKey,
	TalosVaultSchema,
} from "../data/schema";

export type AskNamespace = "chat" | "voice" | "command";

/**
 * runs 表的 LRU 上限（报告 C1 的建议值 32）。
 * 每条记录最多驻留 `context-assembler.ts` 默认上限 24000 字符的脱敏正文，
 * 故常驻内存上界是 32 × 24000，而不是「随会话数无限」。
 */
export const MAX_TRACKED_RUNS = 32;

export interface AskInput extends VaultRetrievalInput {
	sessionId: string;
	namespace: AskNamespace;
	runId: string;
	turnId: string;
	providerId: string;
	query: string;
}

export interface ToolProposalInput {
	runId: string;
	turnId: string;
	sessionId: string;
	namespace: AskNamespace;
	providerId: string;
	toolCallId: string;
	name: string;
	input: Record<string, unknown>;
}

export interface ToolProposalGateway {
	propose(input: ToolProposalInput): Promise<{ taskId: string }>;
}

export interface AskRetriever {
	retrieve(input: VaultRetrievalInput): Promise<VaultRetrievalResult>;
}

export interface TalosAskServiceOptions {
	facade: ProviderFacade;
	retriever: AskRetriever;
	toolGateway: ToolProposalGateway;
	manualReview: () => boolean;
	vaultAccess?: () => "full" | "denied";
	moduleAccess?: (
		providerId: string
	) => Partial<Record<TalosSchemaKey, boolean>>;
	vaultSchema?: () => Partial<TalosVaultSchema>;
	auditSink?: (
		record: ProviderEgressAuditAppendInput
	) => void | Promise<void>;
	configDir?: string;
}

interface RunRecord {
	sessionKey: string;
	runId: string;
	turnId: string;
	providerId: string;
	text: string;
}

export class TalosAskService {
	private readonly sessions = new Map<string, string>();
	/** 按插入序实现 LRU：命中即重排到队尾，超出上限时从队首淘汰。 */
	private readonly runs = new Map<string, RunRecord>();

	constructor(private readonly options: TalosAskServiceOptions) {}

	/** 写入 runs 并按 LRU 淘汰最旧记录，把条目数钉在 MAX_TRACKED_RUNS。 */
	private rememberRun(record: RunRecord): void {
		// 先删再插：Map 的插入序即时间序，重复 runId 也要挪到队尾。
		this.runs.delete(record.runId);
		this.runs.set(record.runId, record);
		while (this.runs.size > MAX_TRACKED_RUNS) {
			const oldest = this.runs.keys().next().value;
			if (oldest === undefined) break;
			this.runs.delete(oldest);
		}
	}

	async *ask(input: AskInput): AsyncIterable<AskEvent> {
		const sessionKey = `${input.namespace}:${input.sessionId}`;
		const activeProvider = this.sessions.get(sessionKey);
		if (!activeProvider) {
			this.options.facade.createSession({
				sessionId: sessionKey,
				providerId: input.providerId,
			});
			this.sessions.set(sessionKey, input.providerId);
		} else if (activeProvider !== input.providerId) {
			this.options.facade.switchProvider(
				sessionKey,
				input.providerId,
				input.turnId
			);
			this.sessions.set(sessionKey, input.providerId);
		}

		const retrieval = await this.options.retriever.retrieve({
			query: input.query,
			attachmentPaths: input.attachmentPaths,
			currentPath: input.currentPath,
			engineResultPaths: input.engineResultPaths,
			recentConfirmedPaths: input.recentConfirmedPaths,
		});
		const assembled = assembleVaultContext(input.query, retrieval, {
			configDir: this.options.configDir,
		});
		const egress = await auditProviderEgress({
			providerId: input.providerId,
			vaultAccess: this.options.vaultAccess?.() ?? "full",
			paths: assembled.usedPaths,
			text: assembled.text,
			moduleAccess: this.options.moduleAccess?.(input.providerId),
			vaultSchema: this.options.vaultSchema?.(),
			configDir: this.options.configDir,
		});
		await this.options.auditSink?.({
			runId: input.runId,
			turnId: input.turnId,
			sessionId: sessionKey,
			namespace: input.namespace,
			audit: egress.audit,
		});
		if (!egress.allowed) {
			yield {
				type: "error",
				message: "Provider 出库隐私审计未通过",
				retryable: false,
			};
			yield { type: "done", sessionId: sessionKey };
			return;
		}
		this.rememberRun({
			sessionKey,
			runId: input.runId,
			turnId: input.turnId,
			providerId: input.providerId,
			text: egress.redactedText,
		});

		const proposed = new Set<string>();
		const manualReview = this.options.manualReview();
		for await (const event of this.options.facade.chat(sessionKey, {
			runId: input.runId,
			turnId: input.turnId,
			text: egress.redactedText,
			toolsAllowed: !manualReview,
		})) {
			if (
				event.type === "tool-request" &&
				manualReview &&
				!proposed.has(event.toolCallId)
			) {
				proposed.add(event.toolCallId);
				await this.options.toolGateway.propose({
					runId: input.runId,
					turnId: input.turnId,
					sessionId: sessionKey,
					namespace: input.namespace,
					providerId: input.providerId,
					toolCallId: event.toolCallId,
					name: event.name,
					input: event.input,
				});
			}
			yield event;
		}
	}

	async *review(
		runId: string,
		providerId: string
	): AsyncIterable<AskEvent> {
		const run = this.runs.get(runId);
		if (!run) {
			throw new Error(
				`Ask run "${runId}" does not exist（仅保留最近 ${MAX_TRACKED_RUNS} 轮）`
			);
		}
		// 一次性消费：review 是 runs 的唯一读取方，命中即删是一条真实的删除路径。
		// 注意不要在 switchProvider 分支加会话清理——那会打断 wp7-e2e 的三次 ask + 一次 review。
		this.runs.delete(runId);
		yield* this.options.facade.reviewTurn(run.sessionKey, providerId, {
			runId: `${runId}:review`,
			turnId: `${run.turnId}:review`,
			reviewOfTurnId: run.turnId,
			text: `请独立复核以下问答上下文，不执行工具：\n\n${run.text}`,
			toolsAllowed: false,
		});
	}
}
