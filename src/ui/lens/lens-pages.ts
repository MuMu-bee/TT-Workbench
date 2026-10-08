// Lens 界面语言的模块注册表：模块按超级大脑的功能划分，侧栏、图标栏、页签与标题共用一处定义
// （与 Lens 的 navigation-model 同理）。图标栏放 5 个快捷模块，其余收进「更多模块」。
import type { App } from "obsidian";
import type { VaultPaths } from "../../data/schema";
import type { LensData } from "./lens-data";

export type LensModuleId =
	| "overview"
	| "collect"
	| "knowledge"
	| "projects"
	| "output"
	| "identity"
	| "system"
	| "assistant"
	| "voice"
	| "preferences";

export interface LensModule {
	id: LensModuleId;
	title: string;
	icon: string;
	tabs?: ReadonlyArray<readonly [string, string]>;
	bottom?: boolean;
	/** 助手不占主区：点击后在右侧边栏打开对话。 */
	external?: boolean;
}

export const LENS_MODULES: readonly LensModule[] = [
	{ id: "overview", title: "总览", icon: "house", tabs: [["today", "今日"], ["rhythm", "执行节奏"]] },
	{ id: "collect", title: "收集", icon: "inbox", tabs: [["pending", "待处理"], ["backlog", "积压分布"]] },
	{ id: "knowledge", title: "知识", icon: "library", tabs: [["insights", "洞察"], ["materials", "素材"], ["moc", "MOC"]] },
	{ id: "projects", title: "项目", icon: "git-branch" },
	{ id: "output", title: "输出", icon: "send", tabs: [["queue", "待发"], ["platforms", "平台"], ["ops", "运营候选"]] },
	{ id: "identity", title: "身份", icon: "fingerprint", tabs: [["context", "身份上下文"], ["soul", "人格"]] },
	{ id: "system", title: "系统", icon: "shield-check", tabs: [["health", "健康"], ["approvals", "审批"], ["capability", "能力"], ["vault", "全库"]] },
	{ id: "assistant", title: "助手", icon: "message-square", external: true },
	{ id: "voice", title: "屈原语音", icon: "audio-lines" },
	{ id: "preferences", title: "设置", icon: "settings", bottom: true },
];

// 与 Lens 图标栏一致：总览、资料（知识）、项目、对话、屈原语音
export const LENS_RAIL_SHORTCUTS: readonly LensModuleId[] = ["overview", "knowledge", "projects", "assistant", "voice"];

export function lensModule(id: LensModuleId): LensModule {
	const found = LENS_MODULES.find((module) => module.id === id);
	if (!found) throw new Error(`未知 Lens 模块：${id}`);
	return found;
}

export function defaultTab(id: LensModuleId): string | null {
	return lensModule(id).tabs?.[0]?.[0] ?? null;
}

export interface LensState {
	projectView: "board" | "list";
	projectFilter: string;
	queries: Record<string, string>;
	deckPages: Record<string, number>;
	ovExpand: string | null;
}

export interface LensContext {
	doc: Document;
	app: App;
	data: LensData;
	paths: VaultPaths;
	profileName: string;
	state: LensState;
	tab: string | null;
	navigate(module: LensModuleId, tab?: string): void;
	rerender(): void;
	openNote(path: string, newTab?: boolean): void;
	openDrawer(path: string): void;
	drawerPath(): string | null;
	openChat(): void;
	renderSettings(host: HTMLElement): void;
	mountVoice(host: HTMLElement): void;
	refresh(): void;
}
