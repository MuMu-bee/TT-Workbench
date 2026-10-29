import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createAgentEvent, type AgentEvent } from "../src/agent-workbench/contracts/agent-events";
import type {
	AgentRuntimeAdapter,
	CreateSessionInput,
	RuntimeTurn,
} from "../src/agent-workbench/contracts/runtime-adapter";
import { unavailableCapabilities } from "../src/agent-workbench/contracts/runtime-capabilities";
import { AgentExecutionCoordinator } from "../src/agent-workbench/core/agent-execution-coordinator";
import { AgentWorkbenchService } from "../src/agent-workbench/core/agent-workbench-service";
import { ConversationService } from "../src/agent-workbench/core/conversation-service";
import { WorkbenchConversationCoordinator } from "../src/agent-workbench/core/workbench-conversation-coordinator";
import {
	ConversationInputLedger,
	type ConversationInputLedgerAdapter,
} from "../src/agent-workbench/storage/conversation-input-ledger";
import {
	PortableConversationStore,
	type PortableFileAdapter,
} from "../src/agent-workbench/storage/portable-conversation-store";
import { RuntimeBindingStore } from "../src/agent-workbench/storage/runtime-binding-store";

class MemoryFiles implements PortableFileAdapter {
	readonly files = new Map<string, string>();
	readonly folders = new Set<string>();
	async exists(path: string) { return this.files.has(path) || this.folders.has(path); }
	async read(path: string) { const value = this.files.get(path); if (value === undefined) throw new Error("missing"); return value; }
	async write(path: string, value: string) { this.files.set(path, value); }
	async rename(from: string, to: string) { this.files.set(to, await this.read(from)); this.files.delete(from); }
	async replace(from: string, to: string) { await this.rename(from, to); }
	async remove(path: string) { this.files.delete(path); }
	async mkdir(path: string) { this.folders.add(path); }
	async list(path: string) {
		const prefix = `${path}/`;
		const files = [...this.files.keys()].filter((item) => item.startsWith(prefix) && !item.slice(prefix.length).includes("/")).map((item) => item.slice(prefix.length));
		return { files, folders: [] };
	}
}

function fixtures(
	send: AgentRuntimeAdapter["send"],
	preflightEgress?: ConstructorParameters<typeof AgentExecutionCoordinator>[0]["preflightEgress"],
	runtimeOverrides: Partial<AgentRuntimeAdapter> = {},
	storeOverrides: { writeBindings?: (value: Record<string, unknown>) => Promise<void> } = {},
) {
	const files = new MemoryFiles();
	const conversations = new ConversationService(new PortableConversationStore(files));
	let bindings: Record<string, unknown> = {};
	const coordinator = new WorkbenchConversationCoordinator(conversations, new RuntimeBindingStore({
		read: async () => bindings,
		write: storeOverrides.writeBindings ?? (async (value) => { bindings = structuredClone(value); }),
	}));
	let ledgerState: Awaited<ReturnType<ConversationInputLedgerAdapter["read"]>> = null;
	const ledger = new ConversationInputLedger({
		read: async () => structuredClone(ledgerState),
		write: async (value) => { ledgerState = structuredClone(value); },
	});
	const runtime: AgentRuntimeAdapter = {
		id: "ohmypi",
		probe: async () => ({ runtimeId: "ohmypi", status: "ready" }),
		listModels: async () => [],
		createSession: async (_input: CreateSessionInput) => ({ runtimeId: "ohmypi", sessionId: "native-1" }),
		resumeSession: async () => undefined,
		send,
		cancel: async () => undefined,
		dispose: async () => undefined,
		capabilities: unavailableCapabilities,
		...runtimeOverrides,
	};
	const createRuntime = vi.fn(async () => runtime);
	const execution = new AgentExecutionCoordinator({
		conversations: coordinator,
		ledger,
		vaultRoot: "/synthetic/vault",
		createRuntime,
		preflightEgress,
	});
	return { conversations, execution, ledger, createRuntime };
}

async function takeEvent(iterator: AsyncGenerator<AgentEvent>): Promise<AgentEvent> {
	const result = await iterator.next();
	if (result.done) throw new Error("expected another agent event");
	return result.value;
}

/** 按 Store 的落盘布局直接写事件文件，用来构造「旧运行时遗留」的历史状态。 */
async function writeStoredEvent(
	files: MemoryFiles,
	conversationId: string,
	event: Record<string, unknown>,
): Promise<void> {
	const digest = createHash("sha256").update(String(event.eventId)).digest("hex");
	await files.write(
		`.talos/agent-workbench/v1/conversations/${conversationId}/events/${digest}.json`,
		`${JSON.stringify(event, null, 2)}\n`,
	);
}

/**
 * Service 级装配：`conversationCoordinator` + `inputLedger` + `vaultRoot` 三者齐备，
 * 才让 `AgentWorkbenchService` 真的建出 `execution`（agent-workbench-service.ts:85）。
 */
function serviceFixture(send: AgentRuntimeAdapter["send"]) {
	const files = new MemoryFiles();
	const conversations = new ConversationService(new PortableConversationStore(files));
	let bindings: Record<string, unknown> = {};
	const conversationCoordinator = new WorkbenchConversationCoordinator(conversations, new RuntimeBindingStore({
		read: async () => bindings,
		write: async (value) => { bindings = structuredClone(value); },
	}));
	let ledgerState: Awaited<ReturnType<ConversationInputLedgerAdapter["read"]>> = null;
	const inputLedger = new ConversationInputLedger({
		read: async () => structuredClone(ledgerState),
		write: async (value) => { ledgerState = structuredClone(value); },
	});
	const runtime: AgentRuntimeAdapter = {
		id: "ohmypi",
		probe: async () => ({ runtimeId: "ohmypi", status: "ready" }),
		listModels: async () => [],
		createSession: async (_input: CreateSessionInput) => ({ runtimeId: "ohmypi", sessionId: "native-1" }),
		resumeSession: async () => undefined,
		send,
		cancel: async () => undefined,
		dispose: async () => undefined,
		capabilities: unavailableCapabilities,
	};
	const service = new AgentWorkbenchService({
		conversationCoordinator,
		inputLedger,
		vaultRoot: "/synthetic/vault",
		createRuntime: async () => runtime,
	});
	return { files, conversations, service };
}

describe("TALOS native execution coordinator", () => {
	it("stages structured input, accepts on first provider event and preserves every request field", async () => {
		let ledger!: ConversationInputLedger;
		const observed: RuntimeTurn[] = [];
		const fixture = fixtures(async function* (turn) {
			observed.push(turn);
			expect((await ledger.list(turn.conversationId))[0]?.stage).toBe("staged");
			yield createAgentEvent({
				eventId: "native-delta",
				conversationId: turn.conversationId,
				turnId: turn.turnId,
				runtimeId: "ohmypi",
				type: "assistant.delta",
				timestamp: "2026-08-28T00:00:00.000Z",
				payload: { text: "done" },
			});
		});
		ledger = fixture.ledger;
		const conversation = await fixture.conversations.create();
		const events = [];
		for await (const event of fixture.execution.execute(conversation, {
			conversationId: conversation.conversationId,
			input: [
				{ type: "text", text: "inspect" },
				{ type: "image", id: "img-1", name: "chart.png", mimeType: "image/png", dataUrl: "data:image/png;base64,YQ==" },
			],
			context: { linkedContent: { path: "notes/current.md", content: "context" }, externalContextPaths: ["/private/local/context.md"], enabledMcpServers: ["vault-tools"] },
			model: "gpt-test",
			reasoning: "high",
			serviceTier: "priority",
			workflow: "plan",
			permissionMode: "ask",
			toolPolicy: { kind: "read-only" },
		})) events.push(event.type);
		expect(events).toEqual(["user.message", "assistant.start", "assistant.delta", "turn.finished"]);
		expect(observed[0]).toMatchObject({
			model: "gpt-test",
			reasoning: "high",
			serviceTier: "priority",
			permissionMode: "ask",
			toolPolicy: { kind: "read-only" },
			context: { linkedContent: { path: "notes/current.md", content: "context" } },
		});
		const records = await ledger.list(conversation.conversationId);
		expect(records).toMatchObject([{ stage: "accepted", images: [{ name: "chart.png", byteLength: 3 }], contextPaths: ["notes/current.md", "[external-context]"] }]);
		expect(JSON.stringify(records)).not.toContain("YQ==");
		expect(JSON.stringify(records)).not.toContain("/private/local");
		const stored = await fixture.conversations.store.load(conversation.conversationId);
		const storedTypes = stored.events.map((event) => event.type);
		expect(storedTypes).not.toContain("assistant.delta");
		expect(storedTypes).toEqual(expect.arrayContaining(["user.message", "assistant.start", "turn.finished"]));
		const storedUser = stored.events.find((event) => event.type === "user.message");
		expect(typeof storedUser?.payload.recordId).toBe("string");
		expect(storedUser?.payload).toMatchObject({ contextPaths: ["notes/current.md", "[external-context]"], images: [{ name: "chart.png" }] });
	});

	it("discards a pre-acceptance input and never replays it after a transport failure", async () => {
		const send = vi.fn((): AsyncIterable<AgentEvent> => ({
			[Symbol.asyncIterator]: () => ({
				next: () => Promise.reject(new Error("transport failed before acceptance")),
			}),
		}));
		const fixture = fixtures(send);
		const conversation = await fixture.conversations.create();
		const events = [];
		for await (const event of fixture.execution.execute(conversation, {
			conversationId: conversation.conversationId,
			input: [{ type: "text", text: "once" }],
			workflow: "plan",
			permissionMode: "ask",
			toolPolicy: { kind: "read-only" },
		})) events.push(event);
		expect(events).toMatchObject([{ type: "error", payload: { accepted: false } }]);
		expect(await fixture.ledger.list(conversation.conversationId)).toEqual([]);
		expect((await fixture.conversations.store.load(conversation.conversationId)).events.some((event) => event.type === "user.message")).toBe(false);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("fails closed before staging or runtime startup when provider egress is denied", async () => {
		const send = vi.fn(async function* () { yield createAgentEvent({ eventId: "unexpected", conversationId: "c", turnId: "t", runtimeId: "ohmypi", type: "turn.finished", timestamp: new Date().toISOString(), payload: {} }); });
		const audit = vi.fn(async () => ({ allowed: false, message: "blocked by audit" }));
		const fixture = fixtures(send, audit);
		const conversation = await fixture.conversations.create();
		await expect(async () => {
			for await (const event of fixture.execution.execute(conversation, {
				conversationId: conversation.conversationId,
				input: [{ type: "text", text: "private prompt" }],
				workflow: "plan",
				permissionMode: "ask",
				toolPolicy: { kind: "read-only" },
			})) throw new Error(`unexpected event: ${event.type}`);
		}).rejects.toThrow("blocked by audit");
		expect(audit).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: "ohmypi", prompt: "private prompt", hasImages: false }));
		expect(send).not.toHaveBeenCalled();
		expect(await fixture.ledger.list(conversation.conversationId)).toEqual([]);
	});

	it("finishes an accepted user cancellation without invalidating it as a runtime error", async () => {
		const fixture = fixtures(async function* (turn) {
			yield createAgentEvent({
				eventId: "accepted-delta",
				conversationId: turn.conversationId,
				turnId: turn.turnId,
				runtimeId: "ohmypi",
				type: "assistant.delta",
				timestamp: "2026-08-28T00:00:00.000Z",
				payload: { text: "partial" },
			});
			await new Promise<void>((_resolve, reject) => {
				turn.signal?.addEventListener("abort", () => reject(new Error("aborted by user")), { once: true });
			});
		});
		const conversation = await fixture.conversations.create();
		const iterator = fixture.execution.execute(conversation, {
			conversationId: conversation.conversationId,
			input: [{ type: "text", text: "cancel me" }],
			workflow: "plan",
			permissionMode: "ask",
			toolPolicy: { kind: "read-only" },
		});
		expect((await takeEvent(iterator)).type).toBe("user.message");
		expect((await takeEvent(iterator)).type).toBe("assistant.start");
		expect((await takeEvent(iterator)).type).toBe("assistant.delta");
		const terminal = iterator.next();
		await Promise.resolve();
		await fixture.execution.cancel(conversation.conversationId);
		const terminalResult = await terminal;
		expect(terminalResult.done).toBe(false);
		expect(terminalResult.value as AgentEvent).toMatchObject({ type: "turn.finished", payload: { status: "cancelled" } });
		expect((await iterator.next()).done).toBe(true);
		const stored = await fixture.conversations.store.load(conversation.conversationId);
		expect(stored.events.some((event) => event.type === "error")).toBe(false);
	});

	it("passes the selected Provider profile identity into egress preflight", async () => {
		const audit = vi.fn(async () => ({ allowed: true }));
		const fixture = fixtures(async function* (turn) {
			yield createAgentEvent({
				eventId: "profile-done",
				conversationId: turn.conversationId,
				turnId: turn.turnId,
				runtimeId: "ohmypi",
				type: "turn.finished",
				timestamp: new Date().toISOString(),
				payload: {},
			});
		}, audit);
		const created = await fixture.conversations.create();
		const conversation = {
			...created,
			selection: {
				runtimeId: "ohmypi" as const,
				providerProfileId: "openai-compatible",
			},
		};
		await fixture.conversations.store.updateManifest(conversation);
		for await (const event of fixture.execution.execute(conversation, {
			conversationId: conversation.conversationId,
			input: [{ type: "text", text: "profile audit" }],
			workflow: "plan",
			permissionMode: "ask",
			toolPolicy: { kind: "read-only" },
		})) void event;
		expect(audit).toHaveBeenCalledWith(expect.objectContaining({
			runtimeId: "ohmypi",
			providerProfileId: "openai-compatible",
		}));
	});

	it("reserves a conversation before asynchronous preflight completes", async () => {
		let releaseAudit!: (value: { allowed: boolean }) => void;
		const auditGate = new Promise<{ allowed: boolean }>((resolve) => { releaseAudit = resolve; });
		const audit = vi.fn(() => auditGate);
		const fixture = fixtures(async function* (turn) {
			yield createAgentEvent({ eventId: "done", conversationId: turn.conversationId, turnId: turn.turnId, runtimeId: "ohmypi", type: "turn.finished", timestamp: new Date().toISOString(), payload: {} });
		}, audit);
		const conversation = await fixture.conversations.create();
		const request = {
			conversationId: conversation.conversationId,
			input: [{ type: "text" as const, text: "only once" }],
			workflow: "plan" as const,
			permissionMode: "ask" as const,
			toolPolicy: { kind: "read-only" as const },
		};
		const first = fixture.execution.execute(conversation, request);
		const firstEvent = first.next();
		await vi.waitFor(() => expect(audit).toHaveBeenCalledTimes(1));
		const duplicate = fixture.execution.execute(conversation, request);
		await expect(duplicate.next()).rejects.toThrow("已有回合");
		releaseAudit({ allowed: true });
		expect((await firstEvent).done).toBe(false);
		for await (const event of first) void event;
	});

	it("runs distinct conversations concurrently while preserving each conversation id", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const send = vi.fn(async function* (turn: RuntimeTurn) {
			await gate;
			yield createAgentEvent({
				eventId: `accepted-${turn.conversationId}`,
				conversationId: turn.conversationId,
				turnId: turn.turnId,
				runtimeId: "ohmypi",
				type: "runtime.status",
				timestamp: new Date().toISOString(),
				payload: { message: "accepted" },
			});
			yield createAgentEvent({
				eventId: `finished-${turn.conversationId}`,
				conversationId: turn.conversationId,
				turnId: turn.turnId,
				runtimeId: "ohmypi",
				type: "turn.finished",
				timestamp: new Date().toISOString(),
				payload: {},
			});
		});
		const fixture = fixtures(send);
		const firstConversation = await fixture.conversations.create("first");
		const secondConversation = await fixture.conversations.create("second");
		const request = (conversationId: string) => ({
			conversationId, input: [{ type: "text" as const, text: conversationId }],
			workflow: "plan" as const, permissionMode: "ask" as const, toolPolicy: { kind: "read-only" as const },
		});
		const first = fixture.execution.execute(firstConversation, request(firstConversation.conversationId));
		const second = fixture.execution.execute(secondConversation, request(secondConversation.conversationId));
		const firstEvent = first.next(); const secondEvent = second.next();
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
		release();
		expect((await firstEvent).value).toMatchObject({ type: "user.message", conversationId: firstConversation.conversationId });
		expect((await secondEvent).value).toMatchObject({ type: "user.message", conversationId: secondConversation.conversationId });
		await Promise.all([(async () => { for await (const event of first) void event; })(), (async () => { for await (const event of second) void event; })()]);
	});

	it("drops cross-turn events and stops after the first terminal event", async () => {
		const fixture = fixtures(async function* (turn) {
			yield createAgentEvent({ eventId: "wrong-turn", conversationId: turn.conversationId, turnId: "stale-turn", runtimeId: "ohmypi", type: "assistant.delta", timestamp: new Date().toISOString(), payload: { text: "stale" } });
			yield createAgentEvent({ eventId: "valid-delta", conversationId: turn.conversationId, turnId: turn.turnId, runtimeId: "ohmypi", type: "assistant.delta", timestamp: new Date().toISOString(), payload: { text: "valid" } });
			yield createAgentEvent({ eventId: "valid-finish", conversationId: turn.conversationId, turnId: turn.turnId, runtimeId: "ohmypi", type: "turn.finished", timestamp: new Date().toISOString(), payload: {} });
			yield createAgentEvent({ eventId: "late-delta", conversationId: turn.conversationId, turnId: turn.turnId, runtimeId: "ohmypi", type: "assistant.delta", timestamp: new Date().toISOString(), payload: { text: "late" } });
		});
		const conversation = await fixture.conversations.create();
		const events: AgentEvent[] = [];
		for await (const event of fixture.execution.execute(conversation, {
			conversationId: conversation.conversationId,
			input: [{ type: "text", text: "fenced" }],
			workflow: "plan",
			permissionMode: "ask",
			toolPolicy: { kind: "read-only" },
		})) events.push(event);
		expect(events.map((event) => event.eventId)).not.toContain("wrong-turn");
		expect(events.map((event) => event.eventId)).not.toContain("late-delta");
		expect(events.map((event) => event.type)).toEqual(["user.message", "assistant.start", "assistant.delta", "turn.finished"]);
	});

	it("responds to a cancelled native question instead of parking the provider", async () => {
		const respondUserInput = vi.fn(async () => undefined);
		const fixture = fixtures(async function* (turn) {
			yield createAgentEvent({ eventId: "question", conversationId: turn.conversationId, turnId: turn.turnId, runtimeId: "ohmypi", type: "user.question", timestamp: new Date().toISOString(), nativeId: "question-1", payload: { questions: [] } });
			yield createAgentEvent({ eventId: "done", conversationId: turn.conversationId, turnId: turn.turnId, runtimeId: "ohmypi", type: "turn.finished", timestamp: new Date().toISOString(), payload: {} });
		}, undefined, { respondUserInput });
		const conversation = await fixture.conversations.create();
		for await (const event of fixture.execution.execute(conversation, {
			conversationId: conversation.conversationId,
			input: [{ type: "text", text: "ask" }],
			workflow: "plan",
			permissionMode: "ask",
			toolPolicy: { kind: "read-only" },
		}, { answer: async () => null })) void event;
		expect(respondUserInput).toHaveBeenCalledWith({ requestId: "question-1", answers: null });
	});

	it("freezes a runtime switch to its target conversation while another tab changes selection", async () => {
		const files = new MemoryFiles();
		const conversations = new ConversationService(new PortableConversationStore(files));
		let bindings: Record<string, unknown> = {};
		const coordinator = new WorkbenchConversationCoordinator(conversations, new RuntimeBindingStore({
			read: async () => bindings,
			write: async (value) => { bindings = structuredClone(value); },
		}));
		const conversation = await conversations.create();
		let releaseSwitch!: () => void;
		const switchGate = new Promise<void>((resolve) => { releaseSwitch = resolve; });
		vi.spyOn(coordinator, "switchRuntime").mockImplementation(async () => { await switchGate; return false; });
		const service = new AgentWorkbenchService({ conversationCoordinator: coordinator });
		// RuntimeId 已收窄为 "ohmypi"，无法再用两个不同运行时名区分「切换目标」与
		// 「另一个标签页的选择」；这里改用同一运行时下的不同 model 保持原断言强度：
		// 落盘 selection 必须冻结成切换目标那一刻的快照，而服务当前选择仍是后设的值。
		const switching = service.switchConversationRuntime(conversation.conversationId, "ohmypi", "target-model");
		expect(service.getSelection()).toEqual({ runtimeId: "ohmypi", model: "target-model" });
		service.selectRuntime("ohmypi", "pi-test");
		releaseSwitch();
		await switching;
		expect((await conversations.store.load(conversation.conversationId)).manifest.selection).toEqual({
			runtimeId: "ohmypi",
			model: "target-model",
		});
		expect(service.getSelection()).toEqual({ runtimeId: "ohmypi", model: "pi-test" });
	});

	it("keeps a provider failure terminal instead of synthesizing a completed turn", async () => {
		const dispose = vi.fn(async () => undefined);
		const fixture = fixtures(async function* (turn) {
			yield createAgentEvent({ eventId: "failed", conversationId: turn.conversationId, turnId: turn.turnId, runtimeId: "ohmypi", type: "error", timestamp: new Date().toISOString(), payload: { message: "provider failed" } });
		}, undefined, { dispose });
		const conversation = await fixture.conversations.create();
		const events: AgentEvent[] = [];
		for await (const event of fixture.execution.execute(conversation, {
			conversationId: conversation.conversationId,
			input: [{ type: "text", text: "fail" }],
			workflow: "plan",
			permissionMode: "ask",
			toolPolicy: { kind: "read-only" },
		})) events.push(event);
		expect(events.map((event) => event.type)).toEqual(["user.message", "assistant.start", "error"]);
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("releases the native process after every terminal turn and resumes the durable binding on demand", async () => {
		const dispose = vi.fn(async () => undefined);
		const createSession = vi.fn(async () => ({ runtimeId: "ohmypi" as const, sessionId: "native-1" }));
		const resumeSession = vi.fn(async () => undefined);
		const fixture = fixtures(async function* (turn) {
			yield createAgentEvent({
				eventId: `finished-${turn.turnId}`,
				conversationId: turn.conversationId,
				turnId: turn.turnId,
				runtimeId: "ohmypi",
				type: "turn.finished",
				timestamp: new Date().toISOString(),
				payload: {},
			});
		}, undefined, { createSession, resumeSession, dispose });
		const conversation = await fixture.conversations.create();
		const request = {
			conversationId: conversation.conversationId,
			input: [{ type: "text" as const, text: "one turn at a time" }],
			workflow: "plan" as const,
			permissionMode: "ask" as const,
			toolPolicy: { kind: "read-only" as const },
		};

		for await (const event of fixture.execution.execute(conversation, request)) void event;
		for await (const event of fixture.execution.execute(conversation, request)) void event;

		expect(fixture.createRuntime).toHaveBeenCalledTimes(2);
		expect(createSession).toHaveBeenCalledTimes(1);
		expect(resumeSession).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalledTimes(2);
	});

	it("keeps the conversation reserved until native process disposal completes", async () => {
		let finishDispose!: () => void;
		const disposeGate = new Promise<void>((resolve) => { finishDispose = resolve; });
		const dispose = vi.fn(() => disposeGate);
		const fixture = fixtures(async function* (turn) {
			yield createAgentEvent({
				eventId: "finished-before-dispose",
				conversationId: turn.conversationId,
				turnId: turn.turnId,
				runtimeId: "ohmypi",
				type: "turn.finished",
				timestamp: new Date().toISOString(),
				payload: {},
			});
		}, undefined, { dispose });
		const conversation = await fixture.conversations.create();
		const request = {
			conversationId: conversation.conversationId,
			input: [{ type: "text" as const, text: "hold until closed" }],
			workflow: "plan" as const,
			permissionMode: "ask" as const,
			toolPolicy: { kind: "read-only" as const },
		};
		const running = (async () => {
			for await (const event of fixture.execution.execute(conversation, request)) void event;
		})();
		await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));

		const duplicate = fixture.execution.execute(conversation, request);
		await expect(duplicate.next()).rejects.toThrow("已有回合");
		finishDispose();
		await running;
	});

	it("deduplicates repeated native terminal frames even when their local event ids differ", async () => {
		const fixture = fixtures(async function* (turn) {
			for (const eventId of ["local-final-1", "local-final-2"]) {
				yield createAgentEvent({
					eventId,
					conversationId: turn.conversationId,
					turnId: turn.turnId,
					runtimeId: "ohmypi",
					type: "assistant.final",
					timestamp: new Date().toISOString(),
					nativeId: "native-final-1",
					payload: { text: "done" },
				});
			}
			yield createAgentEvent({
				eventId: "finished",
				conversationId: turn.conversationId,
				turnId: turn.turnId,
				runtimeId: "ohmypi",
				type: "turn.finished",
				timestamp: new Date().toISOString(),
				payload: {},
			});
		});
		const conversation = await fixture.conversations.create();
		const emitted: AgentEvent[] = [];
		for await (const event of fixture.execution.execute(conversation, {
			conversationId: conversation.conversationId,
			input: [{ type: "text", text: "dedupe" }],
			workflow: "plan",
			permissionMode: "ask",
			toolPolicy: { kind: "read-only" },
		})) emitted.push(event);

		expect(emitted.filter((event) => event.type === "assistant.final")).toHaveLength(1);
		expect((await fixture.conversations.store.load(conversation.conversationId)).events.filter((event) => event.type === "assistant.final")).toHaveLength(1);
	});

	it("rejects compact while a turn is in flight without disposing the live runtime", async () => {
		let releaseSend!: () => void;
		let sending = false;
		const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
		const dispose = vi.fn(async () => undefined);
		const compact = vi.fn(async () => undefined);
		const fixture = fixtures(async function* (turn) {
			sending = true;
			yield createAgentEvent({
				eventId: "accepted-delta",
				conversationId: turn.conversationId,
				turnId: turn.turnId,
				runtimeId: "ohmypi",
				type: "assistant.delta",
				timestamp: new Date().toISOString(),
				payload: { text: "working" },
			});
			await sendGate;
			yield createAgentEvent({
				eventId: "finished-after-compact",
				conversationId: turn.conversationId,
				turnId: turn.turnId,
				runtimeId: "ohmypi",
				type: "turn.finished",
				timestamp: new Date().toISOString(),
				payload: {},
			});
		}, undefined, { dispose, compact });
		const conversation = await fixture.conversations.create();
		const running = (async () => {
			for await (const event of fixture.execution.execute(conversation, {
				conversationId: conversation.conversationId,
				input: [{ type: "text", text: "long turn" }],
				workflow: "plan",
				permissionMode: "ask",
				toolPolicy: { kind: "read-only" },
			})) void event;
		})();
		await vi.waitFor(() => expect(sending).toBe(true));

		// 回合在飞：compact 不得复用租约，必须返回 false 且一次 dispose 都不发生。
		await expect(fixture.execution.compact(conversation.conversationId)).resolves.toBe(false);
		expect(compact).not.toHaveBeenCalled();
		expect(dispose).toHaveBeenCalledTimes(0);

		releaseSend();
		await running;
		// 回合正常收尾后该租约才被 dispose，且整轮只 dispose 一次（没有被 compact 提前摘走）。
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("disposes the runtime when native session creation fails", async () => {
		const dispose = vi.fn(async () => undefined);
		const createSession = vi.fn(async () => { throw new Error("OhMyPi 新会话已取消"); });
		const fixture = fixtures(async function* () {
			yield createAgentEvent({
				eventId: "unexpected",
				conversationId: "unexpected",
				turnId: "unexpected",
				runtimeId: "ohmypi",
				type: "turn.finished",
				timestamp: new Date().toISOString(),
				payload: {},
			});
		}, undefined, { createSession, dispose });
		const conversation = await fixture.conversations.create();
		await expect(async () => {
			for await (const event of fixture.execution.execute(conversation, {
				conversationId: conversation.conversationId,
				input: [{ type: "text", text: "spawn then fail" }],
				workflow: "plan",
				permissionMode: "ask",
				toolPolicy: { kind: "read-only" },
			})) throw new Error(`unexpected event: ${event.type}`);
		}).rejects.toThrow("OhMyPi 新会话已取消");

		expect(createSession).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalledTimes(1);
		// 辅助断言：修前修后都是 false，不作为判别依据。
		expect(fixture.execution.hasActiveTurn(conversation.conversationId)).toBe(false);
	});

	it("disposes the runtime when the native binding cannot be persisted", async () => {
		const dispose = vi.fn(async () => undefined);
		const fixture = fixtures(async function* () {
			yield createAgentEvent({
				eventId: "unexpected",
				conversationId: "unexpected",
				turnId: "unexpected",
				runtimeId: "ohmypi",
				type: "turn.finished",
				timestamp: new Date().toISOString(),
				payload: {},
			});
		}, undefined, { dispose }, {
			writeBindings: async () => { throw new Error("binding 写盘失败"); },
		});
		const conversation = await fixture.conversations.create();
		await expect(async () => {
			for await (const event of fixture.execution.execute(conversation, {
				conversationId: conversation.conversationId,
				input: [{ type: "text", text: "session created, binding fails" }],
				workflow: "plan",
				permissionMode: "ask",
				toolPolicy: { kind: "read-only" },
			})) throw new Error(`unexpected event: ${event.type}`);
		}).rejects.toThrow("binding 写盘失败");

		expect(dispose).toHaveBeenCalledTimes(1);
		expect(fixture.execution.hasActiveTurn(conversation.conversationId)).toBe(false);
	});

	it("carries the last handoff envelope into the next turn history", async () => {
		const observed: RuntimeTurn[] = [];
		const fixture = serviceFixture(async function* (turn) {
			observed.push(turn);
			yield createAgentEvent({
				eventId: "handoff-turn-finished",
				conversationId: turn.conversationId,
				turnId: turn.turnId,
				runtimeId: "ohmypi",
				type: "turn.finished",
				timestamp: "2026-08-30T00:00:02.000Z",
				payload: {},
			});
		});
		await fixture.service.initialize();
		const conversation = await fixture.conversations.create();
		// handoff.created 当前在单运行时下不可达（switchRuntime 对同值早退），
		// 只能直接落盘构造：legacy codex 的两条消息 + 一条 toRuntimeId=ohmypi 的信封。
		await writeStoredEvent(fixture.files, conversation.conversationId, {
			schemaVersion: 1,
			eventId: "legacy-user-1",
			conversationId: conversation.conversationId,
			turnId: "legacy-turn-1",
			runtimeId: "codex",
			type: "user.message",
			timestamp: "2026-08-30T00:00:00.000Z",
			payload: { text: "U-1 旧运行时的用户消息" },
		});
		await writeStoredEvent(fixture.files, conversation.conversationId, {
			schemaVersion: 1,
			eventId: "legacy-assistant-1",
			conversationId: conversation.conversationId,
			turnId: "legacy-turn-1",
			runtimeId: "codex",
			type: "assistant.final",
			timestamp: "2026-08-30T00:00:01.000Z",
			payload: { text: "A-1 旧运行时的回答" },
		});
		await writeStoredEvent(fixture.files, conversation.conversationId, {
			schemaVersion: 1,
			eventId: "legacy-handoff-1",
			conversationId: conversation.conversationId,
			turnId: "handoff-1",
			// handoff.created 的 event.runtimeId 是 fromRuntimeId（coordinator:135），
			// 过滤必须看 payload.toRuntimeId。
			runtimeId: "codex",
			type: "handoff.created",
			timestamp: "2026-08-30T00:00:01.500Z",
			payload: {
				schemaVersion: 1,
				conversationId: conversation.conversationId,
				fromRuntimeId: "codex",
				toRuntimeId: "ohmypi",
				goal: "",
				recentMessages: [
					{ role: "user", text: "U-1 旧运行时的用户消息" },
					{ role: "assistant", text: "A-1 旧运行时的回答" },
				],
				incompleteTasks: [],
				toolResultSummaries: [],
				vaultRelativeReferences: [],
			},
		});
		await fixture.conversations.updateSelection(conversation.conversationId, { runtimeId: "ohmypi" });
		// 先确认构造的落盘状态真的被读回来（否则下面的断言会因「什么都没读到」而空转）。
		const seeded = await fixture.service.loadConversation(conversation.conversationId);
		expect(seeded.events.map((event) => event.eventId)).toEqual(
			expect.arrayContaining(["legacy-user-1", "legacy-assistant-1", "legacy-handoff-1"]),
		);
		expect(seeded.manifest.selection.runtimeId).toBe("ohmypi");

		for await (const event of fixture.service.executeConversationTurn(conversation.conversationId, {
			input: [{ type: "text", text: "继续" }],
			toolPolicy: { kind: "read-only" },
		})) void event;

		expect(observed).toHaveLength(1);
		const history = observed[0]?.history ?? [];
		expect(history.length).toBeGreaterThanOrEqual(2);
		expect(history.map((item) => item.text)).toEqual(expect.arrayContaining([
			"U-1 旧运行时的用户消息",
			"A-1 旧运行时的回答",
		]));
		// 信封里已带的两条不应在尾部再重复一份，但本次新输入不计入 history。
		expect(history).toHaveLength(2);
		expect(history.map((item) => item.role)).toEqual(["user", "assistant"]);
	});
});
