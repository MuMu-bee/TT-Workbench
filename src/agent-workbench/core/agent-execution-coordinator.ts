import type { AgentEvent } from "../contracts/agent-events";
import type { ConversationManifest } from "../contracts/conversation";
import type { AgentExecutionRequest } from "../contracts/execution-request";
import { executionText, runtimePrompt } from "../contracts/execution-request";
import type {
	AgentRuntimeAdapter,
	NativeSessionBinding,
	RuntimeId,
	RuntimeTurn,
} from "../contracts/runtime-adapter";
import type { RuntimeCapabilities } from "../contracts/runtime-capabilities";
import {
	ConversationInputLedger,
	createConversationInputRecord,
} from "../storage/conversation-input-ledger";
import type { WorkbenchConversationCoordinator } from "./workbench-conversation-coordinator";

export interface AgentExecutionInteractions {
	approve?(event: AgentEvent): Promise<"allow" | "allow-always" | "deny" | "cancel">;
	answer?(event: AgentEvent): Promise<Record<string, string | string[]> | null>;
}

export interface AgentExecutionCoordinatorOptions {
	conversations: WorkbenchConversationCoordinator;
	ledger: ConversationInputLedger;
	vaultRoot: string;
	createRuntime(
		runtimeId: RuntimeId,
		conversationId: string,
		selection: ConversationManifest["selection"],
	): Promise<AgentRuntimeAdapter>;
	initialContext?(): string | undefined;
	preflightEgress?(input: {
		runtimeId: RuntimeId;
		providerProfileId?: string;
		conversationId: string;
		prompt: string;
		history?: RuntimeTurn["history"];
		context?: RuntimeTurn["context"];
		hasImages: boolean;
	}): Promise<{ allowed: boolean; message?: string }>;
	onRuntimeInvalidated?(runtimeId: RuntimeId, error: unknown): void;
	/**
	 * Q-ARC4：execute 入口的运行时能力查询。可选——未注入时不做能力校验，
	 * 现有那些只关心会话/租约行为的构造点无需改动。
	 */
	runtimeCapabilities?(runtimeId: RuntimeId): RuntimeCapabilities;
}

const TRANSIENT_RUNTIME_EVENTS = new Set<AgentEvent["type"]>([
	"assistant.delta",
	"thinking.delta",
	"tool.updated",
	"usage.updated",
]);

function shouldPersistRuntimeEvent(event: AgentEvent): boolean {
	return !TRANSIENT_RUNTIME_EVENTS.has(event.type);
}

/**
 * 会话租约已被一个进行中的回合占用。
 *
 * `compact` / `fork` 以 `forTurn: false` 申请租约时，若同一会话的租约正在跑回合，
 * 必须显式失败而不是复用（复用会让它们的 `finally` 把正在跑的 runtime dispose 掉）。
 */
export class LeaseBusyError extends Error {
	constructor(readonly conversationId: string) {
		super("当前会话已有回合正在执行，不能复用其运行时租约");
		this.name = "LeaseBusyError";
	}
}

interface RuntimeLease {
	key: string;
	conversationId: string;
	runtimeId: RuntimeId;
	providerProfileId?: string;
	runtime: AgentRuntimeAdapter;
	binding: NativeSessionBinding;
	generation: number;
	seenEventIds: Set<string>;
	seenNativeEventKeys: Set<string>;
	/** 该租约是否正被 `execute` 的进行中回合持有（只有 `execute` 会置位）。 */
	activeTurn: boolean;
}

interface ActiveExecution {
	conversationId: string;
	turnId: string;
	leaseKey: string;
	generation: number;
	abort: AbortController;
}

function leaseKey(conversationId: string, runtimeId: RuntimeId, providerProfileId?: string): string {
	return `${conversationId}:${runtimeId}:${providerProfileId ?? "native"}`;
}

function titleFromText(value: string): string {
	const line = value.replace(/\s+/g, " ").trim();
	if (!line) return "图片会话";
	return line.length > 42 ? `${line.slice(0, 42)}…` : line;
}

function providerErrorMessage(event: AgentEvent): string {
	if (typeof event.payload.message === "string") return event.payload.message;
	const error = event.payload.error;
	if (error && typeof error === "object" && !Array.isArray(error) && typeof (error as Record<string, unknown>).message === "string") {
		return (error as Record<string, unknown>).message as string;
	}
	return "Provider 回合失败";
}

/**
 * TALOS-owned requested-turn coordinator.
 *
 * It stages local input before provider handoff, accepts it only after the
 * provider produces the first event, and fences every late event by the
 * conversation, lease generation and turn identity that created it.
 */
export class AgentExecutionCoordinator {
	private readonly leases = new Map<string, RuntimeLease>();
	private readonly active = new Map<string, ActiveExecution>();
	private readonly preparing = new Map<string, AbortController>();
	private nextGeneration = 0;
	disposed = false;

	constructor(private readonly options: AgentExecutionCoordinatorOptions) {}

	hasActiveTurn(conversationId: string): boolean {
		return this.active.has(conversationId) || this.preparing.has(conversationId);
	}

	private assertAvailable(): void {
		if (this.disposed) throw new Error("TT 执行协调器已释放");
	}

	private isCurrent(execution: ActiveExecution): boolean {
		const current = this.active.get(execution.conversationId);
		const lease = this.leases.get(execution.leaseKey);
		return current === execution && lease?.generation === execution.generation;
	}

	/** 一次 dispose 同时关掉子进程与 loopback 代理（onDispose 挂在 adapter 上），失败不掩其它路径。 */
	private async disposeQuietly(runtime: AgentRuntimeAdapter): Promise<void> {
		await runtime.dispose().catch(() => undefined);
	}

	private async invalidateLease(lease: RuntimeLease, error: unknown): Promise<void> {
		if (this.leases.get(lease.key) === lease) this.leases.delete(lease.key);
		await this.options.conversations.clearBinding(
			lease.conversationId,
			lease.runtimeId,
			lease.providerProfileId,
		).catch(() => undefined);
		await this.disposeQuietly(lease.runtime);
		this.options.onRuntimeInvalidated?.(lease.runtimeId, error);
	}

	private async releaseLease(lease: RuntimeLease): Promise<void> {
		if (lease.activeTurn) return;
		if (this.leases.get(lease.key) !== lease) return;
		this.leases.delete(lease.key);
		await this.disposeQuietly(lease.runtime);
	}

	/**
	 * `forTurn: true` 分支在 `execute` 下已成死码：`:204-206` 的 active/preparing 守卫
	 * 与 preparing 占位保证同一会话不会二次 acquire，保留它只为与 `forTurn: false`
	 * 的调用方形成防御性对称，不要指望有测试能覆盖它。
	 */
	private async acquireLease(
		conversation: ConversationManifest,
		selection: ConversationManifest["selection"],
		options: { forTurn: boolean } = { forTurn: true },
	): Promise<RuntimeLease> {
		const key = leaseKey(conversation.conversationId, selection.runtimeId, selection.providerProfileId);
		const existing = this.leases.get(key);
		if (existing) {
			// 只看「调用方 forTurn」+「existing.activeTurn」两级：租约上不存 forTurn。
			if (options.forTurn && !existing.activeTurn) return existing;
			throw new LeaseBusyError(conversation.conversationId);
		}
		let runtime = await this.options.createRuntime(selection.runtimeId, conversation.conversationId, selection);
		// runtime 是 let（失败回退分支会重新赋值），catch 必须 dispose 那一刻的当前值。
		try {
			let binding = await this.options.conversations.getBinding(
				conversation.conversationId,
				selection.runtimeId,
				selection.providerProfileId,
			);
			if (binding) {
				try {
					await runtime.resumeSession(binding);
				} catch {
					await runtime.dispose().catch(() => undefined);
					await this.options.conversations.clearBinding(
						conversation.conversationId,
						selection.runtimeId,
						selection.providerProfileId,
					).catch(() => undefined);
					runtime = await this.options.createRuntime(selection.runtimeId, conversation.conversationId, selection);
					binding = null;
				}
			}
			if (!binding) {
				binding = await runtime.createSession({
					conversationId: conversation.conversationId,
					vaultRoot: this.options.vaultRoot,
					model: selection.model,
					providerProfileId: selection.providerProfileId,
					initialContext: this.options.initialContext?.(),
				});
				await this.options.conversations.setBinding(conversation.conversationId, binding);
			}
			const lease: RuntimeLease = {
				key,
				conversationId: conversation.conversationId,
				runtimeId: selection.runtimeId,
				providerProfileId: selection.providerProfileId,
				runtime,
				binding,
				generation: ++this.nextGeneration,
				seenEventIds: new Set(),
				seenNativeEventKeys: new Set(),
				activeTurn: false,
			};
			this.leases.set(key, lease);
			return lease;
		} catch (error) {
			await this.disposeQuietly(runtime);
			throw error;
		}
	}

	async *execute(
		conversation: ConversationManifest,
		request: AgentExecutionRequest,
		interactions: AgentExecutionInteractions = {},
	): AsyncGenerator<AgentEvent> {
		this.assertAvailable();
		const displayText = executionText(request.input);
		if (!displayText && !request.input.some((block) => block.type === "image")) {
			throw new Error("消息或图片不能为空");
		}
		// Q-ARC4：执行前的图片能力校验。用 `conversation.selection.runtimeId`（此时还没有 prepared，
		// 拿不到本次请求解析后的 selection），与 UI 侧 `getRuntimeCapabilities` 走同一张派生表。
		// 回调可选：未注入时（含 fake runtime 的 20+ 构造点）行为不变。
		if (request.input.some((block) => block.type === "image")) {
			const caps = this.options.runtimeCapabilities?.(conversation.selection.runtimeId);
			if (caps?.input.image === "unavailable") {
				throw new Error("当前运行时不支持图片输入，请移除图片后重试");
			}
		}
		const conversationId = conversation.conversationId;
		if (this.active.has(conversationId) || this.preparing.has(conversationId)) {
			throw new Error("当前会话已有回合正在执行");
		}
		const abort = new AbortController();
		const relayAbort = () => abort.abort(request.signal?.reason);
		if (request.signal?.aborted) abort.abort(request.signal.reason);
		else request.signal?.addEventListener("abort", relayAbort, { once: true });
		this.preparing.set(conversationId, abort);
		const prepared = await (async () => {
			try {
				const model = request.model ?? conversation.selection.model;
				const reasoning = request.reasoning ?? conversation.selection.reasoning;
				const serviceTier = request.serviceTier ?? conversation.selection.serviceTier;
				const selection: ConversationManifest["selection"] = {
					runtimeId: conversation.selection.runtimeId,
					...(conversation.selection.providerProfileId ? { providerProfileId: conversation.selection.providerProfileId } : {}),
					...(model ? { model } : {}),
					...(reasoning ? { reasoning } : {}),
					...(serviceTier ? { serviceTier } : {}),
				};
				if (JSON.stringify(conversation.selection) !== JSON.stringify(selection)) {
					conversation = { ...conversation, selection, updatedAt: new Date().toISOString() };
					await this.options.conversations.conversations.store.updateManifest(conversation);
				}
				const recordId = crypto.randomUUID();
				const turnId = crypto.randomUUID();
				const turn: RuntimeTurn = {
					conversationId,
					turnId,
					input: request.input,
					text: displayText,
					context: request.context,
					history: request.history,
					model: request.model ?? selection.model,
					reasoning: request.reasoning ?? selection.reasoning,
					serviceTier: request.serviceTier ?? selection.serviceTier,
					workflow: request.workflow,
					permissionMode: request.permissionMode,
					toolPolicy: request.toolPolicy,
				};
				const preflight = await this.options.preflightEgress?.({
					runtimeId: selection.runtimeId,
					providerProfileId: selection.providerProfileId,
					conversationId,
					prompt: runtimePrompt(turn),
					history: request.history,
					context: request.context,
					hasImages: request.input.some((block) => block.type === "image"),
				});
				if (preflight && !preflight.allowed) throw new Error(preflight.message ?? "Provider 出库隐私审计未通过");
				if (abort.signal.aborted) return null;
				const staged = createConversationInputRecord({
					recordId,
					conversationId,
					turnId,
					runtimeId: selection.runtimeId,
					createdAt: new Date().toISOString(),
					displayText,
					blocks: request.input,
					context: request.context,
				});
				await this.options.ledger.stage(staged);
				let lease: RuntimeLease;
				try {
					lease = await this.acquireLease(conversation, selection);
				} catch (error) {
					await this.options.ledger.discard(recordId).catch(() => undefined);
					throw error;
				}
				if (abort.signal.aborted) {
					await this.options.ledger.discard(recordId).catch(() => undefined);
					await this.releaseLease(lease);
					return null;
				}
				const execution: ActiveExecution = {
					conversationId,
					turnId,
					leaseKey: lease.key,
					generation: lease.generation,
					abort,
				};
				this.active.set(conversationId, execution);
				lease.activeTurn = true;
				return { selection, recordId, turnId, turn, staged, lease, execution };
			} catch (error) {
				request.signal?.removeEventListener("abort", relayAbort);
				if (abort.signal.aborted) return null;
				throw error;
			} finally {
				if (this.preparing.get(conversationId) === abort) this.preparing.delete(conversationId);
			}
		})();
		if (!prepared) {
			request.signal?.removeEventListener("abort", relayAbort);
			return;
		}
		const { selection, recordId, turnId, turn, staged, lease, execution } = prepared;
		let accepted = false;
		let finished = false;
		let providerFailure: AgentEvent | null = null;
		turn.signal = abort.signal;

		try {
			for await (const nativeEvent of lease.runtime.send(turn)) {
				if (!this.isCurrent(execution)) continue;
				if (nativeEvent.conversationId !== conversationId || nativeEvent.turnId !== turnId || nativeEvent.runtimeId !== selection.runtimeId) continue;
				if (lease.seenEventIds.has(nativeEvent.eventId)) continue;
				const nativeEventKey = nativeEvent.nativeId
					? `${nativeEvent.type}:${nativeEvent.nativeId}`
					: null;
				if (nativeEventKey && lease.seenNativeEventKeys.has(nativeEventKey)) continue;
				lease.seenEventIds.add(nativeEvent.eventId);
				if (nativeEventKey) lease.seenNativeEventKeys.add(nativeEventKey);
				if (!accepted) {
					accepted = true;
					await this.options.ledger.accept(recordId, {
						acceptedAt: new Date().toISOString(),
						nativeUserMessageId: nativeEvent.nativeId || undefined,
					});
					const userEvent = await this.options.conversations.appendUser({
						conversationId: conversation.conversationId,
						turnId,
						runtimeId: selection.runtimeId,
						text: displayText || "[图片]",
						vaultRoot: this.options.vaultRoot,
						metadata: {
							recordId,
							images: staged.images,
							contextPaths: staged.contextPaths,
						},
					});
					yield userEvent;
					const startEvent = await this.options.conversations.conversations.append({
						conversationId: conversation.conversationId,
						turnId,
						runtimeId: selection.runtimeId,
						type: "assistant.start",
						payload: {
							sessionInstanceId: lease.key,
							executionGeneration: lease.generation,
							recordId,
						},
					});
					yield startEvent;
					if (conversation.title === "新会话") {
						await this.options.conversations.conversations.rename(conversation.conversationId, titleFromText(displayText));
					}
				}
				if (shouldPersistRuntimeEvent(nativeEvent)) {
					await this.options.conversations.appendRuntimeEvent(
						conversation.conversationId,
						nativeEvent,
						this.options.vaultRoot,
					);
				}
				yield nativeEvent;
				if (nativeEvent.type === "approval.requested") {
					const decision = await interactions.approve?.(nativeEvent) ?? "deny";
					if (nativeEvent.nativeId && lease.runtime.respondApproval) {
						await lease.runtime.respondApproval({ requestId: nativeEvent.nativeId, decision });
					}
					const resolved = await this.options.conversations.conversations.append({
						conversationId: conversation.conversationId,
						turnId,
						runtimeId: selection.runtimeId,
						type: "approval.resolved",
						payload: { requestEventId: nativeEvent.eventId, decision },
					});
					yield resolved;
				}
				if (nativeEvent.type === "user.question") {
					const answers = await interactions.answer?.(nativeEvent) ?? null;
					if (nativeEvent.nativeId && lease.runtime.respondUserInput) {
						await lease.runtime.respondUserInput({ requestId: nativeEvent.nativeId, answers });
					}
				}
				if (nativeEvent.type === "error") { providerFailure = nativeEvent; finished = true; break; }
				if (nativeEvent.type === "turn.finished") { finished = true; break; }
			}
			if (!accepted) {
				await this.options.ledger.discard(recordId);
				throw new Error("运行时未接受本次输入");
			}
			if (providerFailure) {
				await this.invalidateLease(lease, new Error(providerErrorMessage(providerFailure)));
				return;
			}
			if (!finished) {
				const terminal = await this.options.conversations.conversations.append({
					conversationId: conversation.conversationId,
					turnId,
					runtimeId: selection.runtimeId,
					type: "turn.finished",
					payload: { status: abort.signal.aborted ? "cancelled" : "completed", synthesized: true },
				});
				yield terminal;
			}
		} catch (error) {
			if (!accepted) await this.options.ledger.discard(recordId).catch(() => undefined);
			if (abort.signal.aborted) {
				if (accepted && !finished) {
					const terminal = await this.options.conversations.conversations.append({
						conversationId: conversation.conversationId,
						turnId,
						runtimeId: selection.runtimeId,
						type: "turn.finished",
						payload: { status: "cancelled", synthesized: true },
					});
					yield terminal;
				}
				return;
			}
			await this.invalidateLease(lease, error);
			const message = error instanceof Error ? error.message : String(error);
			const errorEvent = await this.options.conversations.conversations.append({
				conversationId: conversation.conversationId,
				turnId,
				runtimeId: selection.runtimeId,
				type: "error",
				payload: { message, recoverable: true, accepted },
			});
			yield errorEvent;
		} finally {
			request.signal?.removeEventListener("abort", relayAbort);
			// 必须先放开归属标记再 releaseLease，否则 releaseLease 会在 activeTurn 上早退，
			// 该租约永远不会被 dispose。releaseLease 在 active.delete 之前的顺序也不能动：
			// tests/agent-workbench-native-execution.test.ts 依赖「dispose 被 gate 挂住时 active 仍在」。
			lease.activeTurn = false;
			await this.releaseLease(lease);
			if (this.active.get(conversation.conversationId) === execution) {
				this.active.delete(conversation.conversationId);
			}
		}
	}

	async cancel(conversationId: string, reason = "user"): Promise<void> {
		this.preparing.get(conversationId)?.abort(reason);
		const active = this.active.get(conversationId);
		if (!active) return;
		active.abort.abort(reason);
		await this.leases.get(active.leaseKey)?.runtime.cancel(reason);
	}

	async steer(conversationId: string, text: string): Promise<boolean> {
		const active = this.active.get(conversationId);
		const lease = active ? this.leases.get(active.leaseKey) : null;
		const runtime = lease?.runtime;
		if (!active || !runtime?.steer) return false;
		const preflight = await this.options.preflightEgress?.({
			runtimeId: runtime.id,
			providerProfileId: lease?.providerProfileId,
			conversationId,
			prompt: text,
			hasImages: false,
		});
		if (preflight && !preflight.allowed) throw new Error(preflight.message ?? "Provider 出库隐私审计未通过");
		await runtime.steer({ turnId: active.turnId, text });
		return true;
	}

	async compact(conversationId: string): Promise<boolean> {
		const projection = await this.options.conversations.conversations.store.load(conversationId);
		const selection = projection.manifest.selection;
		let lease: RuntimeLease;
		try {
			lease = await this.acquireLease(projection.manifest, selection, { forTurn: false });
		} catch (error) {
			// 租约忙只转成 false（`Promise<boolean>` 契约不变），其余错误继续外抛。
			if (error instanceof LeaseBusyError) return false;
			throw error;
		}
		try {
			if (!lease.runtime.compact) return false;
			await lease.runtime.compact({ binding: lease.binding });
			return true;
		} finally {
			await this.releaseLease(lease);
		}
	}

	async fork(conversation: ConversationManifest): Promise<NativeSessionBinding | null> {
		// 不捕获 LeaseBusyError：让它外抛，避免 agent-workbench-service 的 `if (binding)`
		// 静默产出一个没有 binding 的分支。
		const lease = await this.acquireLease(conversation, conversation.selection, { forTurn: false });
		try {
			if (!lease.runtime.fork) return null;
			return await lease.runtime.fork({ binding: lease.binding });
		} finally {
			// Some native runtimes switch their process to the branch as part of fork.
			// Releasing the shared process keeps source and target bindings independent.
			await this.releaseLease(lease);
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		for (const abort of this.preparing.values()) abort.abort("plugin-unload");
		this.preparing.clear();
		for (const execution of this.active.values()) execution.abort.abort("plugin-unload");
		this.active.clear();
		const leases = [...this.leases.values()];
		this.leases.clear();
		await Promise.all(leases.map((lease) => lease.runtime.dispose().catch(() => undefined)));
	}
}
