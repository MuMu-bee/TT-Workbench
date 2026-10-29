import {
	createBuiltinActionRegistry,
	type BuiltinActionDependencies,
	type BuiltinActionScopes,
} from "./action-core/builtin-actions";
import type {
	ApprovalTaskRunInput,
	ApprovalTaskRuntime,
} from "./approval-task-runtime";
import type { RecoveryStore } from "./task-core/recovery-store";
import { MemoryTaskStore } from "./task-core/task-store";
import {
	TalosTaskRunner,
	type TaskTimerHost,
} from "./task-core/task-runner";

export type ConsoleActionDependencies = BuiltinActionDependencies;

/** 待确认提案表的条数上限（Q-ARC3：换数据结构不等于可以无界增长）。 */
export const MAX_PENDING_PROPOSALS = 64;
/** 待确认提案的存活时长；过期即淘汰，不依赖任何消费方。 */
export const PENDING_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 待确认的工具提案。它不再是 TalosTaskRun 形状——`provider-tool-proposal`
 * 从来不在 builtin-actions 的 8 个注册 id 里，进 task store 只会变成
 * 「未注册动作」的死任务，还会被总览「进行中」计数污染。
 */
export interface PendingToolProposal {
	providerId: string;
	runId: string;
	toolCallId: string;
	createdAt: number;
}

export interface ConsoleActionRuntime {
	readonly registry: ReturnType<typeof createBuiltinActionRegistry>;
	readonly store: MemoryTaskStore;
	readonly recoveryStore: RecoveryStore;
	readonly runner: TalosTaskRunner;
	readonly approvals: ApprovalTaskRuntime;
	/** 有界、带 TTL 的待确认提案表。 */
	readonly proposals: ReadonlyMap<string, PendingToolProposal>;
	proposeProviderTool(input: {
		runId: string;
		toolCallId: string;
		providerId: string;
	}): { taskId: string };
}

export function createConsoleActionRuntime(options: {
	dependencies: ConsoleActionDependencies;
	recoveryStore: RecoveryStore;
	timers: TaskTimerHost;
	scopes: BuiltinActionScopes;
	/** 可注入以便 TTL 用例；默认取 PENDING_PROPOSAL_TTL_MS。 */
	maxPendingProposals?: number;
	pendingProposalTtlMs?: number;
}): ConsoleActionRuntime {
	const registry = createBuiltinActionRegistry(
		options.dependencies,
		options.scopes
	);
	const store = new MemoryTaskStore();
	// 快照有上限的 recovery store（VaultRecoveryStore）只能淘汰已终结任务的快照，
	// 它自己看不到任务状态，故在此把「任务状态查询」接上（Q-PER5）。
	options.recoveryStore.setTaskStateResolver?.(
		(taskId) => store.get(taskId)?.state
	);
	const runner = new TalosTaskRunner(
		registry,
		store,
		options.recoveryStore,
		options.timers
	);
	const approvals: ApprovalTaskRuntime = {
		store,
		run: (input: ApprovalTaskRunInput) =>
			runner.run({
				actionId: "decide-approval",
				idempotencyKey: input.idempotencyKey,
				input,
				approvalGranted: true,
				request: {
					readPaths: [input.pendingApprovalsPath, input.targetPath],
					writePaths: [input.pendingApprovalsPath, input.targetPath],
					effects: ["write"],
				},
			}),
	};

	const maxPendingProposals = options.maxPendingProposals ?? MAX_PENDING_PROPOSALS;
	const pendingProposalTtlMs =
		options.pendingProposalTtlMs ?? PENDING_PROPOSAL_TTL_MS;
	// Map 的插入序即时间序：淘汰永远从最旧的一头开始。
	const proposals = new Map<string, PendingToolProposal>();
	const now = (): number => Date.now();

	const evictExpiredProposals = (): void => {
		const deadline = now() - pendingProposalTtlMs;
		for (const [key, proposal] of proposals) {
			if (proposal.createdAt > deadline) break;
			proposals.delete(key);
		}
	};

	return {
		registry,
		store,
		recoveryStore: options.recoveryStore,
		runner,
		approvals,
		proposals,
		proposeProviderTool(input) {
			const idempotencyKey =
				`canonical:${input.providerId}:${input.runId}:${input.toolCallId}`;
			evictExpiredProposals();
			const existing = proposals.get(idempotencyKey);
			if (existing) return { taskId: idempotencyKey };
			// taskId 形状保留：ai/ask-service 的 ToolGateway 契约只要求返回 taskId。
			proposals.set(idempotencyKey, {
				providerId: input.providerId,
				runId: input.runId,
				toolCallId: input.toolCallId,
				createdAt: now(),
			});
			while (proposals.size > maxPendingProposals) {
				const oldest = proposals.keys().next();
				if (oldest.done) break;
				proposals.delete(oldest.value);
			}
			return { taskId: idempotencyKey };
		},
	};
}
