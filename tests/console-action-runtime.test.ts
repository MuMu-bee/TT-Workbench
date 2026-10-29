import {
	clearTimeout as nodeClearTimeout,
	setTimeout as nodeSetTimeout,
} from "node:timers";
import { describe, expect, it, vi } from "vitest";
import {
	createConsoleActionRuntime,
	MAX_PENDING_PROPOSALS,
	type ConsoleActionDependencies,
} from "../src/console-action-runtime";
import { noteScopesFromSchema } from "../src/action-core/note-scopes";
import { MemoryRecoveryStore } from "../src/task-core/recovery-store";
import type { TaskTimerHost } from "../src/task-core/task-runner";
import { resolveSchema } from "../src/data/schema";

const nodeTimers: TaskTimerHost = {
	schedule: (callback, timeoutMs) => nodeSetTimeout(callback, timeoutMs),
	cancel: (handle) => nodeClearTimeout(handle as NodeJS.Timeout),
};

// 写入范围由 schema 派生；生产装配点同样如此，测试不再自备一份旧目录。
const scopes = noteScopesFromSchema(resolveSchema(undefined));

function dependencies(): ConsoleActionDependencies {
	return {
		refreshStats: vi.fn().mockResolvedValue({ refreshed: true }),
		vaultLint: vi.fn().mockResolvedValue({ issues: 0 }),
		deepResearch: vi.fn().mockResolvedValue({ report: "synthetic.md" }),
		createNote: vi.fn().mockResolvedValue({ path: "00-收件箱/new.md" }),
		publishBackfill: vi.fn().mockResolvedValue({ published: true }),
		decideApproval: vi.fn(async (input: unknown) => {
			const task = input as { execute(): Promise<unknown> };
			return task.execute();
		}),
		decidePreference: vi.fn().mockResolvedValue({ decided: true }),
		moveInboxNote: vi.fn().mockResolvedValue({ moved: true }),
	};
}

describe("production console action runtime", () => {
	it("shares one registry, runner, task store and recovery store across console and approvals", async () => {
		const recoveryStore = new MemoryRecoveryStore();
		const runtime = createConsoleActionRuntime({
			dependencies: dependencies(),
			recoveryStore,
			timers: nodeTimers,
			scopes,
		});

		expect(runtime.registry.list()).toHaveLength(8);
		expect(runtime.recoveryStore).toBe(recoveryStore);
		expect(runtime.approvals.store).toBe(runtime.store);

		const task = await runtime.approvals.run({
			idempotencyKey: "production-approval",
			title: "合成审批",
			pendingApprovalsPath: "50 工作流/pending.md",
			targetPath: "输出/result.md",
			execute: vi.fn().mockResolvedValue({ ok: true }),
		});

		expect(task.state).toBe("completed");
		expect(runtime.store.get(task.id)).toBe(task);
	});

	it("keeps provider tool proposals out of the shared console task store", () => {
		const runtime = createConsoleActionRuntime({
			dependencies: dependencies(),
			recoveryStore: new MemoryRecoveryStore(),
			timers: nodeTimers,
			scopes,
		});

		const first = runtime.proposeProviderTool({
			runId: "run-1",
			toolCallId: "tool-1",
			providerId: "mock-provider",
		});
		const second = runtime.proposeProviderTool({
			runId: "run-1",
			toolCallId: "tool-1",
			providerId: "mock-provider",
		});
		const laterRun = runtime.proposeProviderTool({
			runId: "run-2",
			toolCallId: "tool-1",
			providerId: "mock-provider",
		});

		// task store 里不再有任何提案记录（原先把未注册 id 固化成预期）
		expect(runtime.store.list()).toHaveLength(0);
		// 同键复用、换 runId 产生新提案
		expect(second.taskId).toBe(first.taskId);
		expect(laterRun.taskId).not.toBe(first.taskId);
		expect(runtime.proposals.size).toBe(2);
		// registry 里查不到该 id：提案不是可执行动作
		expect(runtime.registry.get("provider-tool-proposal")).toBeUndefined();
		expect(runtime.registry.list()).toHaveLength(8);
	});

	it("keeps every stored actionId resolvable in the registry and no active proposal rows", () => {
		const runtime = createConsoleActionRuntime({
			dependencies: dependencies(),
			recoveryStore: new MemoryRecoveryStore(),
			timers: nodeTimers,
			scopes,
		});

		runtime.proposeProviderTool({
			runId: "run-9",
			toolCallId: "tool-9",
			providerId: "mock-provider",
		});

		// view.ts:759 的「进行中」口径不再有死任务
		const activeStates = new Set(["ready", "queued", "running"]);
		const active = runtime.store
			.list()
			.filter((run) => activeStates.has(run.state));
		expect(active).toHaveLength(0);
		// 兜底过滤的前提：store 里任何 actionId 都能在 registry 命中
		expect(
			runtime.store
				.list()
				.every((task) => runtime.registry.get(task.actionId) !== undefined)
		).toBe(true);
	});

	it("bounds the pending proposal table at MAX_PENDING_PROPOSALS over 200 distinct keys", () => {
		const runtime = createConsoleActionRuntime({
			dependencies: dependencies(),
			recoveryStore: new MemoryRecoveryStore(),
			timers: nodeTimers,
			scopes,
		});

		for (let i = 0; i < 200; i++) {
			runtime.proposeProviderTool({
				runId: `run-${i}`,
				toolCallId: `tool-${i}`,
				providerId: "mock-provider",
			});
		}

		expect(runtime.proposals.size).toBeLessThanOrEqual(MAX_PENDING_PROPOSALS);
		expect(runtime.proposals.size).toBe(MAX_PENDING_PROPOSALS);
		// 最旧的被淘汰、最新的还在（Map 插入序即时间序）
		expect(runtime.proposals.has("canonical:mock-provider:run-0:tool-0")).toBe(false);
		expect(runtime.proposals.has("canonical:mock-provider:run-199:tool-199")).toBe(true);
		expect(runtime.store.list()).toHaveLength(0);
	});

	it("evicts proposals older than the injected TTL", async () => {
		const runtime = createConsoleActionRuntime({
			dependencies: dependencies(),
			recoveryStore: new MemoryRecoveryStore(),
			timers: nodeTimers,
			scopes,
			pendingProposalTtlMs: 1,
		});

		const first = runtime.proposeProviderTool({
			runId: "run-old",
			toolCallId: "tool-old",
			providerId: "mock-provider",
		});
		expect(runtime.proposals.has(first.taskId)).toBe(true);

		await new Promise((resolve) => nodeSetTimeout(resolve, 2));

		runtime.proposeProviderTool({
			runId: "run-new",
			toolCallId: "tool-new",
			providerId: "mock-provider",
		});

		// 旧提案按 TTL 被清掉，新提案在表内
		expect(runtime.proposals.has(first.taskId)).toBe(false);
		expect(runtime.proposals.has("canonical:mock-provider:run-new:tool-new")).toBe(true);
		expect(runtime.proposals.size).toBe(1);
	});
});
