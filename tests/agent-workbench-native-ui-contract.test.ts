import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AgentWorkbenchService } from "../src/agent-workbench/core/agent-workbench-service";
import { migrateLegacyTabManagerState, WorkbenchUiStateStore } from "../src/agent-workbench/storage/workbench-ui-state-store";
import { pluginSource as readPluginSource, expectSourceContains, expectSourceNotContains } from "./helpers/source-text";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = (path: string) => readFileSync(`${root}${path}`, "utf8");
const conversation = source("src/agent-workbench/ui/native-conversation-view.ts");
const serviceSource = source("src/agent-workbench/core/agent-workbench-service.ts");
const renderer = source("src/agent-workbench/ui/native-event-renderer.ts");
const main = readPluginSource();
const css = source("styles.ui-v2.css");

describe("TALOS native agent workbench UI", () => {
	it("owns every production chat entry without importing the retired implementation", () => {
		expect(main).toContain("TalosAgentRecoveryView");
		expect(main).not.toContain("setSystemContext(this.quyuanSoul");
		expect(main).not.toContain("setSystemContext(plugin.quyuanSoul");
		expect(main).toContain("VIEW_TYPE_TALOS_AGENT_RECOVERY");
		expect(main).toContain("ConversationInputLedger");
		expect(main).toContain("WorkbenchUiStateStore");
		expect(main).not.toContain("ClaudianCompatibilityHost");
		expect(main).not.toContain("createClaudianProviderAdapters");
		expect(main).not.toContain("quyuan/claudian");
	});

	it("keeps Plan/Execute orthogonal to Ask/Scoped/Vault Full", () => {
		const service = new AgentWorkbenchService({});
		service.setWorkflowMode("execute");
		service.setPermissionMode("vault-full");
		service.setWorkflowMode("plan");
		expect(service.getPermissionMode()).toBe("vault-full");
		// RuntimeId 已收窄为单值 "ohmypi"（runtime-adapter.ts:9），因此这里改为
		// 逐次做「重新选运行时 + 换 model」，逐次断言 permissionMode 不被带走——
		// 正交性覆盖面不因合法运行时只剩一个而缩小。
		for (const model of [undefined, "model-a", "model-b"]) {
			service.selectRuntime("ohmypi", model);
			expect(service.getPermissionMode()).toBe("vault-full");
			expect(service.getWorkflowMode()).toBe("plan");
		}
	});

	it("preserves the validated runtime/model/permission chrome and accessibility contracts", () => {
		for (const token of [
			"talos-agent-runtime-switcher", "talos-agent-runtime-button", "talos-agent-provider-picker",
			"talos-agent-model-control", "talos-agent-model-trigger", "talos-agent-model-menu",
			"talos-agent-workflow", "talos-agent-permission-trigger", "talos-agent-permission-menu",
			"talos-agent-runtime-status", "talos-agent-install-link", "talos-agent-handoff-marker",
		]) expectSourceContains("src/agent-workbench/ui/talos-agent-workbench.ts", token);
		for (const token of ["talos-agent-reasoning-control", "talos-agent-service-tier-control", "persistCurrentSelection"]) expectSourceContains("src/agent-workbench/ui/talos-agent-workbench.ts", token);
		expectSourceContains("src/agent-workbench/ui/talos-agent-workbench.ts", 'setAttribute("aria-live", "polite")');
		expectSourceContains("src/agent-workbench/ui/talos-agent-workbench.ts", 'setAttribute("role", "listbox")');
		expectSourceContains("styles.ui-v2.css", "@media (prefers-reduced-motion: reduce)");
		expectSourceContains("styles.ui-v2.css", "@container talos-main (max-width: 720px)");
	});

	it("keeps tabs and composer inside the fixed-height native conversation viewport", () => {
		expect(css).toMatch(/\.talos-agent-compatibility-body\s*\{[^}]*display:\s*flex;[^}]*overflow:\s*hidden;/s);
		expect(css).toMatch(/\.talos-native-chat\s*>\s*\.claudian-tab-bar-container\s*\{[^}]*flex:\s*0\s+0\s+auto;/s);
		expect(css).toMatch(/\.talos-native-chat-main\s*\{[^}]*display:\s*flex;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
		expect(css).toMatch(/\.talos-native-chat\s+\.claudian-active-input-slot\s*\{[^}]*flex:\s*0\s+0\s+auto;/s);
		expectSourceContains("styles.ui-v2.css", ".talos-agent-reasoning-control[hidden]");
		expectSourceContains("styles.ui-v2.css", ".talos-agent-service-tier-control[hidden]");
	});

	it("keeps tabs, history, search, attachments, images, MCP, commands, queueing and inline edit", () => {
		for (const token of [
			"claudian-tab-bar-container", "claudian-history-container", "claudian-history-list",
			"renderHistory", "renameConversation", "toggleLifecycle", "exportConversation",
			"queuedDraft", "steerConversationTurn", "confirmInlineEdit", "answerQuestion",
		]) expectSourceContains("src/agent-workbench/ui/native-conversation-view.ts", token);
		for (const token of [
			"@ 添加文件", "addImages", "LocalFilePreviewPicker", "discoverMcpServers", "enabledMcpServers",
			'"/compact"', '"/fork"', '"/new"', '"/plan"', '"/execute"', "onInlineEdit", "handleSubmitButton",
		]) expectSourceContains("src/agent-workbench/ui/native-composer.ts", token);
		expectSourceContains("src/agent-workbench/ui/native-conversation-view.ts", "MAX_OPEN_CONVERSATIONS = 6");
		expectSourceContains("src/agent-workbench/ui/native-conversation-view.ts", "pendingInteractionCancels");
		expectSourceContains("src/agent-workbench/ui/native-conversation-view.ts", "newConversationRequest");
		expectSourceContains("src/agent-workbench/ui/native-conversation-view.ts", "claudian-history-item-summary");
		expectSourceContains("src/agent-workbench/ui/native-event-renderer.ts", "appendPendingUser");
		expectSourceContains("src/agent-workbench/ui/native-event-renderer.ts", "renderVersion");
	});

	it("fences stale tab loads and keeps existing tabs in stable order", () => {
		const openStart = conversation.indexOf("private async openConversation");
		const openEnd = conversation.indexOf("private async closeTab", openStart);
		const open = conversation.slice(openStart, openEnd);
		expect(open).toContain("requestVersion !== this.openRequestVersion");
		expectSourceContains("src/agent-workbench/ui/native-conversation-view.ts", "projection.manifest.selection.runtimeId");
		const trackStart = conversation.indexOf("private trackOpenConversation");
		const trackEnd = conversation.indexOf("private renderTabs", trackStart);
		const track = conversation.slice(trackStart, trackEnd);
		expect(track).toContain("this.openConversationIds.includes(id)");
		expect(track).not.toContain("filter((candidate) => candidate !== id)");
	});

	it("makes runtime selection visible before asynchronous handoff persistence", () => {
		const start = serviceSource.indexOf("async switchConversationRuntime");
		const end = serviceSource.indexOf("async persistConversationSelection", start);
		const body = serviceSource.slice(start, end);
		expect(body.indexOf("this.selectRuntime(runtimeId, model)")).toBeLessThan(body.indexOf("await coordinator.switchRuntime"));
		expect(body).toContain("const targetSelection = this.getSelection()");
		// 审查 F8:持久化改为经 ConversationService 的封装入口,选择仍按目标值写入。
		expect(body).toContain("coordinator.conversations.updateSelection(conversationId, targetSelection)");
		expect(body).toContain("this.restoreSelection(previous)");
	});

	it("never persists a blank conversation during passive startup recovery", () => {
		const restoreStart = conversation.indexOf("private async restoreConversations");
		const restoreEnd = conversation.indexOf("private async refreshManifests", restoreStart);
		const restore = conversation.slice(restoreStart, restoreEnd);
		expect(restore).not.toContain("service.createConversation");
		expect(restore).toContain("this.activeConversationId = null");
		const submitStart = conversation.indexOf("private async submit");
		const submitEnd = conversation.indexOf("private async stop", submitStart);
		const submit = conversation.slice(submitStart, submitEnd);
		expect(submit).toContain("await this.newConversation()");
		const createStart = conversation.indexOf("private async createOrReuseConversation");
		const createEnd = conversation.indexOf("async selectRuntime", createStart);
		expect(conversation.slice(createStart, createEnd)).toContain("!this.isRunning(currentId)");
		expectSourceContains("src/agent-workbench/ui/native-conversation-view.ts", "runningConversationIds");
		expectSourceContains("src/agent-workbench/ui/native-conversation-view.ts", "queuedDrafts");
		expectSourceNotContains("src/agent-workbench/ui/native-conversation-view.ts", "当前回合仍在运行，请先停止后再切换会话");
		expectSourceContains("src/agent-workbench/ui/native-conversation-view.ts", "pendingUserEvents");
		expectSourceContains("src/agent-workbench/ui/native-conversation-view.ts", "discardEmptyConversation");
		expectSourceContains("src/agent-workbench/ui/native-conversation-view.ts", "this.isRunning(evictedId)");
		expectSourceContains("src/agent-workbench/core/agent-workbench-service.ts", "this.execution?.hasActiveTurn(conversationId)");
	});

	it("renders the complete provider-neutral event vocabulary incrementally", () => {
		for (const event of [
			"assistant.delta", "assistant.final", "thinking.delta", "plan.updated", "tool.started",
			"tool.updated", "tool.finished", "file.diff", "task.progress", "subagent.updated",
			"usage.updated", "context.compacted", "handoff.created", "approval.resolved", "user.question",
		]) expectSourceContains("src/agent-workbench/ui/native-event-renderer.ts", event);
		expectSourceContains("src/agent-workbench/ui/native-event-renderer.ts", "StreamRenderScheduler");
		expectSourceContains("src/agent-workbench/ui/native-event-renderer.ts", "MarkdownRenderer.render");
		expectSourceNotContains("src/agent-workbench/ui/native-event-renderer.ts", "usageSummary");
		expectSourceContains("src/agent-workbench/ui/native-event-renderer.ts", "intentionally not rendered");
		expectSourceContains("src/agent-workbench/ui/native-event-renderer.ts", "clearTransientTurn");
		const appendStart = renderer.indexOf("async append(event");
		const appendBody = renderer.slice(appendStart, renderer.indexOf("destroy(): void", appendStart));
		expect(appendBody).toContain('event.type === "assistant.start"');
		expect(appendBody).not.toContain('event.type === "assistant.start") this.ensureAssistant');
		expectSourceNotContains("src/agent-workbench/ui/native-event-renderer.ts", "displayJson(event.payload.usage ?? event.payload)");
		expectSourceContains("src/agent-workbench/ui/native-conversation-view.ts", "card.dataset.conversationId");
	});

	it("renders policy-owned approval phases without persistent C or unknown approval", () => {
		expectSourceContains("src/agent-workbench/core/agent-workbench-service.ts", "return service.authorizeTool");
		expectSourceContains("src/agent-workbench/core/agent-workbench-service.ts", "proposalAvailable");
		expectSourceContains("src/agent-workbench/ui/native-conversation-view.ts", "提案预览");
		expectSourceContains("src/agent-workbench/ui/native-conversation-view.ts", "独立执行批准");
		expectSourceContains("src/agent-workbench/ui/native-conversation-view.ts", "确认提案");
		expectSourceContains("src/agent-workbench/ui/native-conversation-view.ts", "批准执行");
		expectSourceContains("src/agent-workbench/ui/native-conversation-view.ts", "risk === \"B\" && actionKind !== \"unknown\"");
		expectSourceContains("src/agent-workbench/ui/native-conversation-view.ts", "recovery: policy.recovery");
	});

	it("retains the exact visual CSS module graph under TALOS ownership", () => {
		for (const module of [
			"components/messages.css", "components/input.css", "components/tabs.css", "components/toolcalls.css",
			"features/diff.css", "features/inline-edit.css", "features/file-preview.css",
			"features/ask-user-question.css", "toolbar/model-selector.css", "toolbar/permission-toggle.css",
		]) expectSourceContains("src/agent-workbench/ui/styles/index.css", module);
	});

	it("restores open tabs, active tab and history panel state", async () => {
		let persisted: unknown = null;
		const store = new WorkbenchUiStateStore({
			read: async () => persisted,
			write: async (value) => { persisted = structuredClone(value); },
		});
		await store.save({ schemaVersion: 1, openConversationIds: ["a", "a", "b"], activeConversationId: "b", historyOpen: true });
		await expect(store.load()).resolves.toEqual({ schemaVersion: 1, openConversationIds: ["a", "b"], activeConversationId: "b", historyOpen: true });
	});

	it("distinguishes never-saved state from an explicitly saved empty tab list", async () => {
		const neverSaved = new WorkbenchUiStateStore({
			read: async () => null,
			write: async () => undefined,
		});
		await expect(neverSaved.load()).resolves.toBeNull();

		let persisted: unknown = null;
		const allClosed = new WorkbenchUiStateStore({
			read: async () => persisted,
			write: async (value) => { persisted = structuredClone(value); },
		});
		await allClosed.save({ schemaVersion: 1, openConversationIds: [], historyOpen: false });
		await expect(allClosed.load()).resolves.toEqual({ schemaVersion: 1, openConversationIds: [], historyOpen: false });
	});

	it("recovers the save queue after one transient write failure", async () => {
		// 报告 :36 的现状：一次瞬时 IO 失败把 this.tail 永久毒化——之后每次 save 都在
		// then 里短路（adapter 一次都不再被调用），load 还复用同一条旧错。
		let persisted: unknown = null;
		let writes = 0;
		const store = new WorkbenchUiStateStore({
			read: async () => persisted,
			write: async (value) => {
				writes += 1;
				if (writes === 2) throw new Error("disk full (transient)");
				persisted = structuredClone(value);
			},
		});

		await expect(store.save({ schemaVersion: 1, openConversationIds: ["a"], historyOpen: false })).resolves.toBeUndefined();
		await expect(store.save({ schemaVersion: 1, openConversationIds: ["a", "b"], historyOpen: false }))
			.rejects.toThrow("disk full (transient)");
		const writesAfterFailure = writes;

		await expect(store.save({
			schemaVersion: 1,
			openConversationIds: ["a", "b", "c"],
			activeConversationId: "c",
			historyOpen: true,
		})).resolves.toBeUndefined();
		// 关键断言：失败之后 adapter 被重新调用（旧写法这里是 +0）
		expect(writes).toBe(writesAfterFailure + 1);
		await expect(store.load()).resolves.toEqual({
			schemaVersion: 1,
			openConversationIds: ["a", "b", "c"],
			activeConversationId: "c",
			historyOpen: true,
		});
	});

	it("keeps a read failure visible instead of reporting never-saved", async () => {
		// null 的语义是「从未保存过」（native-conversation-view 据此走 active.slice(0,6)
		// 自动重开最近会话）；读失败不能伪装成首次运行，必须照旧上抛到 mount 的 catch。
		const failing = new WorkbenchUiStateStore({
			read: async () => { throw new Error("read failed: io"); },
			write: async () => undefined,
		});
		await expect(failing.load()).rejects.toThrow("read failed: io");
	});

	it("hides soft-deleted conversations from history and never uses window.prompt for rename", () => {
		// 软删除（lifecycle=deleted）的会话必须从会话历史主列表隐藏，
		// 否则已删会话与活跃会话外观一致地堆积，造成"删了还在/克隆"的错觉。
		const historyStart = conversation.indexOf("private async renderHistory");
		const historyEnd = conversation.indexOf("private historyAction", historyStart);
		const historyBody = conversation.slice(historyStart, historyEnd);
		expect(historyBody).toContain('lifecycle !== "deleted"');
		// archived 仍可展示（可恢复），因此过滤只针对 deleted。
		expect(historyBody).not.toContain('lifecycle === "deleted"');
		expect(historyBody).not.toContain('lifecycle !== "archived"');

		// 重命名不能用 window.prompt()（Electron/Obsidian 不实现，返回 null 即静默失败），
		// 必须用原生 Obsidian Modal。
		const renameStart = conversation.indexOf("private async renameConversation");
		const renameEnd = conversation.indexOf("private promptForTitle", renameStart);
		const renameBody = conversation.slice(renameStart, renameEnd);
		expect(renameBody).not.toContain(".prompt(");
		expect(renameBody).toContain("this.promptForTitle(");
		expectSourceContains("src/agent-workbench/ui/native-conversation-view.ts", "new Modal(");
		expectSourceContains("src/agent-workbench/ui/native-conversation-view.ts", "modal-button-container");
	});

	it("projects retired tab ids through the read-only import manifest", () => {
		expect(migrateLegacyTabManagerState({
			openTabs: [
				{ tabId: "tab-a", conversationId: "legacy-a" },
				{ tabId: "tab-b", conversationId: "legacy-b" },
			],
			activeTabId: "tab-b",
		}, {
			imports: {
				a: { legacyConversationId: "legacy-a", conversationId: "native-a" },
				b: { legacyConversationId: "legacy-b", conversationId: "native-b" },
			},
		})).toEqual({
			schemaVersion: 1,
			openConversationIds: ["native-a", "native-b"],
			activeConversationId: "native-b",
			historyOpen: false,
		});
	});
});
