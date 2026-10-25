import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	TalosChatSurface,
	type ChatSurfaceWorkbench,
} from "../src/quyuan/chat-surface";
import { createMiniHost } from "./helpers/mini-dom";
import { pluginSource as readPluginSource } from "./helpers/source-text";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const nativeViewSource = readFileSync(
	`${projectRoot}src/agent-workbench/ui/native-conversation-view.ts`,
	"utf8"
);
const mainSource = readPluginSource();

interface ChatSurfaceMocks {
	mount: ReturnType<typeof vi.fn>;
	suspend: ReturnType<typeof vi.fn>;
	focusComposer: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
}

function workbench(): ChatSurfaceWorkbench & {
	activeTabId: string;
	running: boolean;
	mount: ReturnType<typeof vi.fn>;
	suspend: ReturnType<typeof vi.fn>;
	focusComposer: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
	mocks: ChatSurfaceMocks;
} {
	// 断言经由闭包中的 mock 引用,避免对接口方法签名的 unbound-method 引用。
	const mocks: ChatSurfaceMocks = {
		mount: vi.fn().mockResolvedValue(undefined),
		suspend: vi.fn().mockResolvedValue(undefined),
		focusComposer: vi.fn(),
		destroy: vi.fn().mockResolvedValue(undefined),
	};
	const runtime = Object.assign(
		{ activeTabId: "tab-2", running: true },
		mocks,
	) as unknown as ChatSurfaceWorkbench & ChatSurfaceMocks & {
		activeTabId: string;
		running: boolean;
	};
	return Object.assign(runtime, { mocks });
}

const mockOf = (
	runtime: ReturnType<typeof workbench>,
	name: keyof ChatSurfaceMocks,
): ReturnType<typeof vi.fn> => runtime.mocks[name];

describe("TalosChatSurface", () => {
	it("mounts the same surface only once for the same container", async () => {
		const runtime = workbench();
		const surface = new TalosChatSurface(runtime);
		const { host } = createMiniHost();

		await surface.mount(host, "chat");
		await surface.mount(host, "chat");

		expect(mockOf(runtime, 'mount')).toHaveBeenCalledOnce();
		expect(mockOf(runtime, 'mount')).toHaveBeenCalledWith(host, "chat");
	});

	it("suspends UI without cancelling a running task and restores the tab", async () => {
		const runtime = workbench();
		const surface = new TalosChatSurface(runtime);
		const first = createMiniHost();
		const second = createMiniHost();

		await surface.mount(first.host, "chat");
		await surface.unmount();
		expect(mockOf(runtime, 'suspend')).toHaveBeenCalledOnce();
		expect(runtime.running).toBe(true);
		expect(runtime.activeTabId).toBe("tab-2");

		await surface.mount(second.host, "chat");
		expect(mockOf(runtime, 'mount')).toHaveBeenCalledTimes(2);
		expect(runtime.activeTabId).toBe("tab-2");
	});

	it("accepts only the chat history namespace and never requests voice", async () => {
		const runtime = workbench();
		const surface = new TalosChatSurface(runtime);
		const { host } = createMiniHost();

		await expect(
			surface.mount(host, "voice" as "chat")
		).rejects.toThrow("chat");
		expect(mockOf(runtime, 'mount')).not.toHaveBeenCalled();

		await surface.mount(host, "chat");
		expect(mockOf(runtime, 'mount')).toHaveBeenLastCalledWith(host, "chat");
	});

	it("delegates composer focus and destroys only on final disposal", async () => {
		const runtime = workbench();
		const surface = new TalosChatSurface(runtime);
		const { host } = createMiniHost();

		await surface.mount(host, "chat");
		surface.focusComposer();
		await surface.unmount();
		expect(mockOf(runtime, 'destroy')).not.toHaveBeenCalled();

		await surface.dispose();
		expect(mockOf(runtime, 'focusComposer')).toHaveBeenCalledOnce();
		expect(mockOf(runtime, 'destroy')).toHaveBeenCalledOnce();
	});

	it("keeps the real embedded suspend path non-destructive", () => {
		const start = nativeViewSource.indexOf("async suspend()");
		const end = nativeViewSource.indexOf("async destroy()", start);
		const suspendSource = nativeViewSource.slice(start, end);
		expect(start).toBeGreaterThan(0);
		expect(suspendSource).toContain("this.root?.remove()");
		expect(suspendSource).not.toContain("cancelConversationTurn");
		expect(suspendSource).not.toContain("destroy()");
	});

	it("keeps the old command id while routing it into the right sidebar chat", () => {
		expect(mainSource).toContain('id: "open-quyuan-v2"');
		expect(mainSource).toContain("await revealChatSidebar(this.app.workspace)");
		expect(mainSource).toContain('id: "open-quyuan-v2-recovery"');
	});
});
