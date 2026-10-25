export type TalosPrimaryPageKey =
	| "today"
	| "flow"
	| "projects"
	| "assistant"
	| "system"
	| "settings";

export type TalosSecondaryPageKey =
	| "today"
	| "daily"
	| "inbox"
	| "knowledge"
	| "output"
	| "projects"
	| "talos"
	| "chat"
	| "jarvis"
	| "harness"
	| "health"
	| "vault"
	| "capability"
	| "identity"
	| "settings";

export interface TalosSecondaryPage {
	key: TalosSecondaryPageKey;
	label: string;
	icon: string;
}

export interface TalosPrimaryPage {
	key: TalosPrimaryPageKey;
	label: string;
	icon: string;
	subtitle: string;
	children: readonly TalosSecondaryPage[];
}

export interface TalosPageRoute {
	primary: TalosPrimaryPageKey;
	secondary?: TalosSecondaryPageKey;
}

// 2026-10-07 导航重构：按「今天做什么 → 内容怎么流转 → 项目推进 → 助手 → 系统」组织，
// 每项数据只有一个主场页面，其他页面只放带跳转的提醒。二级页 key 沿用原页面 key，
// 页面实现与样式不受分组变化影响。
export const PRIMARY_NAVIGATION: readonly TalosPrimaryPage[] = [
	{
		key: "today",
		label: "今日",
		icon: "sun",
		subtitle: "现在最该做什么：焦点、待决策与今日节奏",
		children: [
			{ key: "today", label: "今日", icon: "sun" },
			{ key: "daily", label: "执行节奏", icon: "calendar-check" },
		],
	},
	{
		key: "flow",
		label: "内容流",
		icon: "waypoints",
		subtitle: "素材从收件到发布的每一站",
		children: [
			{ key: "inbox", label: "收件箱", icon: "inbox" },
			{ key: "knowledge", label: "知识库", icon: "brain" },
			{ key: "output", label: "输出", icon: "send" },
		],
	},
	{
		key: "projects",
		label: "项目",
		icon: "folder-kanban",
		subtitle: "项目组合、重点项目与 TT 发布闸门",
		children: [
			{ key: "projects", label: "项目场景", icon: "folder-kanban" },
			{ key: "talos", label: "TT 产品", icon: "filter" },
		],
	},
	{
		key: "assistant",
		label: "助手",
		icon: "messages-square",
		subtitle: "AI 对话（右侧边栏）、屈原语音与 DeepSeek Harness",
		children: [
			{ key: "chat", label: "AI 对话", icon: "messages-square" },
			{ key: "jarvis", label: "语音", icon: "audio-lines" },
			{ key: "harness", label: "Harness", icon: "square-terminal" },
		],
	},
	{
		key: "system",
		label: "系统",
		icon: "settings-2",
		subtitle: "健康、全库、能力与身份",
		children: [
			{ key: "health", label: "系统健康", icon: "activity" },
			{ key: "vault", label: "全库视图", icon: "database" },
			{ key: "capability", label: "能力中心", icon: "blocks" },
			{ key: "identity", label: "身份上下文", icon: "fingerprint" },
		],
	},
	// 与 Lens 一致：设置单独放在导航底部，不混入业务分组。
	{
		key: "settings",
		label: "设置",
		icon: "settings",
		subtitle: "插件界面、目录、数据源与 AI 配置",
		children: [{ key: "settings", label: "设置", icon: "settings" }],
	},
] as const;

export const LEGACY_PAGE_KEYS = [
	"overview",
	"today",
	"daily",
	"jarvis",
	"inbox",
	"output",
	"projects",
	"knowledge",
	"identity",
	"talos",
	"health",
	"capability",
	"vault",
] as const;

// 旧页面 key（含已保存的视图状态与命令入口）统一映射到新分组。
const PAGE_ROUTES: Readonly<Record<string, TalosPageRoute>> = {
	today: { primary: "today", secondary: "today" },
	overview: { primary: "today", secondary: "today" },
	workbench: { primary: "today", secondary: "today" },
	daily: { primary: "today", secondary: "daily" },
	flow: { primary: "flow", secondary: "inbox" },
	workflow: { primary: "flow", secondary: "inbox" },
	inbox: { primary: "flow", secondary: "inbox" },
	knowledge: { primary: "flow", secondary: "knowledge" },
	output: { primary: "flow", secondary: "output" },
	projects: { primary: "projects", secondary: "projects" },
	talos: { primary: "projects", secondary: "talos" },
	assistant: { primary: "assistant", secondary: "chat" },
	chat: { primary: "assistant", secondary: "chat" },
	"talos-quyuan-view": { primary: "assistant", secondary: "chat" },
	voice: { primary: "assistant", secondary: "jarvis" },
	jarvis: { primary: "assistant", secondary: "jarvis" },
	harness: { primary: "assistant", secondary: "harness" },
	dsh: { primary: "assistant", secondary: "harness" },
	system: { primary: "system", secondary: "health" },
	health: { primary: "system", secondary: "health" },
	vault: { primary: "system", secondary: "vault" },
	capability: { primary: "system", secondary: "capability" },
	identity: { primary: "system", secondary: "identity" },
	settings: { primary: "settings", secondary: "settings" },
};

export interface WorkbenchModuleEntry {
	key:
		| "inbox"
		| "identity"
		| "logs"
		| "insights"
		| "assets"
		| "projects"
		| "workflows"
		| "output"
		| "archive";
	label: string;
	pageKey: string;
	icon: string;
}

export const WORKBENCH_MODULES: readonly WorkbenchModuleEntry[] = [
	{ key: "inbox", label: "收件箱", pageKey: "inbox", icon: "inbox" },
	{ key: "identity", label: "身份", pageKey: "identity", icon: "fingerprint" },
	{ key: "logs", label: "日志", pageKey: "daily", icon: "notebook-pen" },
	{ key: "insights", label: "洞察", pageKey: "knowledge", icon: "lightbulb" },
	{ key: "assets", label: "素材", pageKey: "knowledge", icon: "library" },
	{ key: "projects", label: "项目", pageKey: "projects", icon: "folder-kanban" },
	{ key: "workflows", label: "工作流", pageKey: "workflow", icon: "workflow" },
	{ key: "output", label: "输出", pageKey: "output", icon: "send" },
	{ key: "archive", label: "归档", pageKey: "vault", icon: "archive" },
] as const;

export function resolvePageRoute(pageKey: string): TalosPageRoute | null {
	const route = PAGE_ROUTES[pageKey];
	return route ? { ...route } : null;
}

export function primaryPage(
	key: TalosPrimaryPageKey
): TalosPrimaryPage {
	const page = PRIMARY_NAVIGATION.find((item) => item.key === key);
	if (!page) throw new Error(`未知一级页面：${key}`);
	return page;
}

export function defaultRouteForPrimary(
	key: TalosPrimaryPageKey
): TalosPageRoute {
	const page = primaryPage(key);
	return page.children[0]
		? { primary: key, secondary: page.children[0].key }
		: { primary: key };
}

/** 页头上下文：「分组 · 页面」；分组只有一个同名页面时只显示一次。 */
export function routeContextLabel(route: TalosPageRoute): string {
	const group = primaryPage(route.primary);
	const page = group.children.find((child) => child.key === route.secondary);
	return page && page.label !== group.label ? `${group.label} · ${page.label}` : group.label;
}
