// 右侧边栏的 TALOS 对话视图：与 Claudian 一样常驻右栏，主区页面保持不动。
// 工作台实例独立于控制台主视图，只在本视图内挂载，关闭视图即释放。
import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { ChatSurfaceWorkbench } from "../quyuan/chat-surface";
import { DeferredChatWorkbench } from "../quyuan/deferred-chat-workbench";
import type { AgentWorkbenchService } from "../agent-workbench/core/agent-workbench-service";

export const VIEW_TYPE_TALOS_CHAT = "talos-agent-chat";

export interface ChatSidebarHost {
	icon: string;
	waitForAgentWorkbench(): Promise<{ service: AgentWorkbenchService }>;
}

export class TalosChatSidebarView extends ItemView {
	private workbench: ChatSurfaceWorkbench | null = null;
	private mountError: string | null = null;

	constructor(leaf: WorkspaceLeaf, private readonly host: ChatSidebarHost) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_TALOS_CHAT;
	}

	getDisplayText(): string {
		return "TALOS 对话";
	}

	getIcon(): string {
		return this.host.icon;
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("talos-chat-sidebar");
		const surface = this.contentEl.createDiv({ cls: "talos-chat-sidebar__surface" });
		this.workbench = new DeferredChatWorkbench(async () => {
			const { service } = await this.host.waitForAgentWorkbench();
			const { TalosAgentWorkbench } = await import("../agent-workbench/ui/talos-agent-workbench");
			return new TalosAgentWorkbench({ leaf: this.leaf, service });
		});
		try {
			await this.workbench.mount(surface, "chat");
			this.mountError = null;
		} catch (error) {
			this.mountError = error instanceof Error ? error.message : String(error);
			surface.empty();
			const panel = surface.createDiv({ cls: "talos-chat-sidebar__error" });
			panel.createEl("strong", { text: "TALOS 对话加载失败" });
			panel.createEl("p", { text: this.mountError });
		}
	}

	focusComposer(): void {
		if (!this.mountError) this.workbench?.focusComposer();
	}

	async onClose(): Promise<void> {
		const workbench = this.workbench;
		this.workbench = null;
		await workbench?.destroy();
	}
}

interface SidebarWorkspace {
	getLeavesOfType(type: string): WorkspaceLeaf[];
	getRightLeaf(split: boolean): WorkspaceLeaf | null;
	revealLeaf(leaf: WorkspaceLeaf): Promise<void> | void;
}

/** 打开（或复用）右侧边栏对话视图并聚焦输入框。 */
export async function revealChatSidebar(workspace: SidebarWorkspace): Promise<WorkspaceLeaf | null> {
	let leaf: WorkspaceLeaf | undefined = workspace.getLeavesOfType(VIEW_TYPE_TALOS_CHAT)[0];
	if (!leaf) {
		const created = workspace.getRightLeaf(false);
		if (!created) return null;
		await created.setViewState({ type: VIEW_TYPE_TALOS_CHAT, active: true });
		leaf = created;
	}
	await workspace.revealLeaf(leaf);
	if (leaf.view instanceof TalosChatSidebarView) leaf.view.focusComposer();
	return leaf;
}
