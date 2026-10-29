import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMiniHost, MiniDocument } from "./helpers/mini-dom";

/**
 * Q-ARC4：能力表必须真的有读取方。
 *
 * 现状（改动前）：`grep -rn "\.capabilities(" src/` 的 3 处命中全在 `ai/provider`
 * （另一套 ProviderCapability），`src/agent-workbench/` 内为 0——能力表只写不读，
 * UI 该隐藏哪些控件、执行器该拒绝哪些输入全靠硬编码。
 *
 * 本文件按方案的三条消费点做「行为断言」（不用不可达的 grep 口径）：
 *  a）`deriveRuntimeCapabilities` 在一次带图片的 native 回回合中被调用 ≥ 1 次；
 *  b）composer 的 `options.capabilities` 在构造后被调用 ≥ 1 次；
 *  c）coordinator 的 `runtimeCapabilities` 在 execute 入口被调用 ≥ 1 次，
 *     且入参 runtimeId 等于 `conversation.selection.runtimeId`。
 *
 * harness 前置（方案 step 6 已写明，本轮照做）：
 *  - `vi.mock("obsidian")` 必须提供 Modal（否则 `local-preview-modal.ts:8` 抛 No "Modal" export）；
 *  - mini-dom 需补 `createElementNS`（`context-usage.ts:109`），已在 tests/helpers/mini-dom.ts 补；
 *  - 需要 `globalThis.activeDocument`，并给 composer 一个最小 app 桩。
 */

const deriveSpy = vi.fn();

vi.mock("obsidian", () => ({
	App: class {},
	Component: class {
		load(): void {}
		unload(): void {}
	},
	MarkdownView: class {},
	MarkdownRenderer: { render: async () => undefined },
	Modal: class {},
	FuzzySuggestModal: class {},
	TFile: class {},
	Notice: class {
		constructor(_message?: string, _timeout?: number) {}
	},
	normalizePath: (path: string): string => path,
	Platform: { isWin: true, isMacOS: false, isLinux: false, isMobile: false },
	setIcon: (): void => undefined,
	requestUrl: vi.fn(),
}));

/**
 * 只把 deriveRuntimeCapabilities 包一层计数：真函数仍然被调用（保留真实返回值），
 * 所以「被调用 ≥ 1 次」不是 mock 自证，而是真实派生路径被走到。
 */
vi.mock("../src/agent-workbench/config/runtime-capabilities", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/agent-workbench/config/runtime-capabilities")>();
	return {
		...actual,
		deriveRuntimeCapabilities: (input: Parameters<typeof actual.deriveRuntimeCapabilities>[0]) => {
			deriveSpy(input);
			return actual.deriveRuntimeCapabilities(input);
		},
	};
});

const { AgentWorkbenchService } = await import("../src/agent-workbench/core/agent-workbench-service");
const { AgentExecutionCoordinator } = await import("../src/agent-workbench/core/agent-execution-coordinator");
const { ConversationService } = await import("../src/agent-workbench/core/conversation-service");
const { WorkbenchConversationCoordinator } = await import("../src/agent-workbench/core/workbench-conversation-coordinator");
const { ConversationInputLedger } = await import("../src/agent-workbench/storage/conversation-input-ledger");
const { PortableConversationStore } = await import("../src/agent-workbench/storage/portable-conversation-store");
const { RuntimeBindingStore } = await import("../src/agent-workbench/storage/runtime-binding-store");
const { NativeComposer } = await import("../src/agent-workbench/ui/native-composer");
const { unavailableCapabilities } = await import("../src/agent-workbench/contracts/runtime-capabilities");
const { deriveRuntimeCapabilities } = await import("../src/agent-workbench/config/runtime-capabilities");

type LedgerAdapter = ConstructorParameters<typeof ConversationInputLedger>[0];

/** 内存文件系统：只实现 PortableConversationStore 需要的六个方法。 */
class MemoryFiles {
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
		const files = [...this.files.keys()]
			.filter((item) => item.startsWith(prefix) && !item.slice(prefix.length).includes("/"))
			.map((item) => item.slice(prefix.length));
		return { files, folders: [] };
	}
}

/** coordinator 夹具：真实会话/账本存储 + 一个不回任何事件的 runtime。 */
function coordinatorFixture(runtimeCapabilities?: (runtimeId: "ohmypi") => ReturnType<typeof unavailableCapabilities>) {
	const files = new MemoryFiles();
	const conversations = new ConversationService(new PortableConversationStore(files));
	let bindings: Record<string, unknown> = {};
	const coordinator = new WorkbenchConversationCoordinator(conversations, new RuntimeBindingStore({
		read: async () => bindings,
		write: async (value) => { bindings = structuredClone(value); },
	}));
	let ledgerState: Awaited<ReturnType<LedgerAdapter["read"]>> = null;
	const ledger = new ConversationInputLedger({
		read: async () => structuredClone(ledgerState),
		write: async (value) => { ledgerState = structuredClone(value); },
	});
	const runtime = {
		id: "ohmypi" as const,
		probe: async () => ({ runtimeId: "ohmypi" as const, status: "ready" as const }),
		listModels: async () => [],
		createSession: async () => ({ runtimeId: "ohmypi" as const, sessionId: "native-1" }),
		resumeSession: async () => undefined,
		// 不回事件也不报错：execute 的入口校验发生在 send 之前，本用例只关心入口。
		send: async function* () { /* no events */ },
		cancel: async () => undefined,
		dispose: async () => undefined,
		capabilities: unavailableCapabilities,
	};
	const execution = new AgentExecutionCoordinator({
		conversations: coordinator,
		ledger,
		vaultRoot: "/synthetic/vault",
		createRuntime: async () => runtime,
		...(runtimeCapabilities ? { runtimeCapabilities } : {}),
	});
	return { coordinator, execution };
}

const imageBlock = {
	type: "image" as const,
	id: "img-1",
	name: "chart.png",
	mimeType: "image/png" as const,
	dataUrl: "data:image/png;base64,YQ==",
};

beforeEach(() => {
	deriveSpy.mockClear();
	// composer 的 iconButton 在拿不到 ownerDocument 时回落到 activeDocument（Obsidian 提供）。
	const document = new MiniDocument();
	(globalThis as unknown as { activeDocument: unknown }).activeDocument = document;
});

describe("capability derivation consumers (Q-ARC4)", () => {
	it("derives capabilities during a native image turn", async () => {
		// 真实派生（ohmypi 无 Direct API profile → image: native）→ 图片回合不被入口校验拦住，
		// deriveSpy 记到的是真实派生调用，而不是 mock 自证。
		const { coordinator, execution } = coordinatorFixture((runtimeId) => deriveRuntimeCapabilities({ runtimeId }));
		const manifest = await coordinator.conversations.create("能力表用例");
		deriveSpy.mockClear();
		const iterator = execution.execute(
			{ ...manifest, selection: { runtimeId: "ohmypi" } },
			{
				conversationId: manifest.conversationId,
				input: [{ type: "text", text: "看图" }, imageBlock],
				workflow: "plan",
				permissionMode: "ask",
				toolPolicy: { kind: "provider-default" },
			},
		);
		// 只需推进到首个 yield：入口校验在第一次 next() 里同步发生。
		await iterator.next();
		await iterator.return(undefined);
		expect(deriveSpy).toHaveBeenCalled();
		expect(deriveSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
		expect(deriveSpy.mock.calls[0]?.[0]).toEqual({ runtimeId: "ohmypi", providerProfile: undefined });
	});

	it("calls the coordinator capability hook with conversation.selection.runtimeId", async () => {
		const seen: string[] = [];
		const { coordinator, execution } = coordinatorFixture((runtimeId) => {
			seen.push(runtimeId);
			return deriveRuntimeCapabilities({ runtimeId });
		});
		const manifest = await coordinator.conversations.create("runtime 入参用例");
		const iterator = execution.execute(
			{ ...manifest, selection: { runtimeId: "ohmypi" } },
			{
				conversationId: manifest.conversationId,
				input: [{ type: "text", text: "看图" }, imageBlock],
				workflow: "plan",
				permissionMode: "ask",
				toolPolicy: { kind: "provider-default" },
			},
		);
		await iterator.next();
		await iterator.return(undefined);
		expect(seen).toEqual(["ohmypi"]);
	});

	it("refuses an image turn when the runtime reports image input as unavailable", async () => {
		const { coordinator, execution } = coordinatorFixture(() => unavailableCapabilities());
		const manifest = await coordinator.conversations.create("图片拒绝用例");
		const iterator = execution.execute(
			{ ...manifest, selection: { runtimeId: "ohmypi" } },
			{
				conversationId: manifest.conversationId,
				input: [{ type: "text", text: "看图" }, imageBlock],
				workflow: "plan",
				permissionMode: "ask",
				toolPolicy: { kind: "provider-default" },
			},
		);
		await expect(iterator.next()).rejects.toThrow("当前运行时不支持图片输入");
	});

	it("disables the composer image button when the capability table reports image unavailable", () => {
		const { host, element } = createMiniHost();
		const capabilities = vi.fn(() => ({
			...unavailableCapabilities(),
			input: { ...unavailableCapabilities().input, image: "unavailable" as const },
		}));
		const composer = new NativeComposer(host, {
			app: {
				vault: { adapter: { exists: async () => false, read: async () => "" } },
				workspace: { getActiveFile: () => null },
			} as never,
			onSubmit: async () => undefined,
			onStop: async () => undefined,
			onCompact: async () => undefined,
			onFork: async () => undefined,
			onNewConversation: async () => undefined,
			onWorkflow: () => undefined,
			onRefine: async (text) => text,
			onInlineEdit: async () => undefined,
			capabilities,
		});
		expect(capabilities).toHaveBeenCalled();
		const imageButton = element.querySelectorAll(".claudian-input-nav-btn")
			.find((button) => button.getAttribute("aria-label")?.startsWith("添加图片"))!;
		expect(imageButton).toBeDefined();
		expect(imageButton.disabled).toBe(true);
		expect(imageButton.classList.contains("is-unavailable")).toBe(true);
		composer.destroy();
	});

	it("keeps the constant gate first: the button stays disabled whatever the capability table says", () => {
		const { host, element } = createMiniHost();
		// IMAGE_INPUT_BLOCKED_REASON 当前恒非空（native-composer.ts:15），本条锁住「常量优先」语义：
		// 即使能力表说图片可用，按钮仍禁用。解禁（常量置 null）单列为另一项，不在 Q-ARC4 范围内。
		const composer = new NativeComposer(host, {
			app: {
				vault: { adapter: { exists: async () => false, read: async () => "" } },
				workspace: { getActiveFile: () => null },
			} as never,
			onSubmit: async () => undefined,
			onStop: async () => undefined,
			onCompact: async () => undefined,
			onFork: async () => undefined,
			onNewConversation: async () => undefined,
			onWorkflow: () => undefined,
			onRefine: async (text) => text,
			onInlineEdit: async () => undefined,
			capabilities: () => ({
				...unavailableCapabilities(),
				input: { ...unavailableCapabilities().input, image: "talos-emulated" as const },
			}),
		});
		const imageButton = element.querySelectorAll(".claudian-input-nav-btn")
			.find((button) => button.getAttribute("aria-label")?.startsWith("添加图片"))!;
		expect(imageButton.disabled).toBe(true);
		expect(imageButton.classList.contains("is-unavailable")).toBe(true);
		composer.destroy();
	});

	it("does not fall back to the never-populated runtimes registry", () => {
		// 真实形状：`new AgentWorkbenchService({})`（见 tests/agent-workbench-native-ui-contract.test.ts:33）。
		const service = new AgentWorkbenchService({});
		// 无选中 Direct API profile → 原生 ohmypi 能力（image native），而不是回落 unavailable。
		expect(service.getRuntimeCapabilities("ohmypi").input.image).toBe("native");
		expect(service.getRuntimeCapabilities("ohmypi").tools.shell).toBe("native");
	});
});
