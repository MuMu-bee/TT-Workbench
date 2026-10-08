import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { pluginSource } from "./helpers/source-text";

vi.mock("obsidian", () => ({
	ItemView: class {
		contentEl = { empty() {}, addClass() {}, createDiv() { return {}; } };
		constructor(public leaf: unknown) {}
	},
}));

const { revealChatSidebar, VIEW_TYPE_TALOS_CHAT } = await import("../src/plugin/chat-sidebar-view");

function fakeLeaf() {
	return { view: null, setViewState: vi.fn(async () => undefined) };
}

describe("right sidebar chat", () => {
	it("creates the chat view in the right sidebar the first time", async () => {
		const leaf = fakeLeaf();
		const workspace = { getLeavesOfType: vi.fn(() => []), getRightLeaf: vi.fn(() => leaf), revealLeaf: vi.fn() };
		await expect(revealChatSidebar(workspace as never)).resolves.toBe(leaf);
		expect(workspace.getRightLeaf).toHaveBeenCalledWith(false);
		expect(leaf.setViewState).toHaveBeenCalledWith({ type: VIEW_TYPE_TALOS_CHAT, active: true });
		expect(workspace.revealLeaf).toHaveBeenCalledWith(leaf);
	});

	it("reuses an existing chat leaf instead of opening another", async () => {
		const leaf = fakeLeaf();
		const workspace = { getLeavesOfType: vi.fn(() => [leaf]), getRightLeaf: vi.fn(), revealLeaf: vi.fn() };
		await revealChatSidebar(workspace as never);
		expect(workspace.getRightLeaf).not.toHaveBeenCalled();
		expect(leaf.setViewState).not.toHaveBeenCalled();
	});

	it("registers the view and routes every chat entry to the sidebar", () => {
		const main = pluginSource();
		expect(main).toContain("VIEW_TYPE_TALOS_CHAT,");
		expect(main).toContain('id: "open-chat-sidebar"');
		const view = readFileSync(new URL("../src/view.ts", import.meta.url), "utf8");
		const render = view.slice(view.indexOf("\trenderPage(): void {"), view.indexOf("\tprivate syncPixelScene"));
		expect(render.indexOf('if (this.activePage === "chat")')).toBeLessThan(render.indexOf("const page = this.pageEl;"));
		expect(render).toContain("void this.plugin.activateChatSidebar();");
	});
});
