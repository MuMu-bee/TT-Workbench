// 收件箱逐条分诊的纯函数层：主题规则、目标建议、移动计划与动作请求。
// 不接触 App，写回由 plugin/action-runtime.ts 的受控动作完成。
import type { TalosActionRequest } from "./action-core/types";

export type TriageTargetKey = "insights" | "assets" | "projects" | "output" | "archive";

/** 分诊可选的目标目录，顺序即「改判」下拉顺序。 */
export const TRIAGE_TARGET_KEYS: readonly TriageTargetKey[] = [
	"insights",
	"assets",
	"projects",
	"output",
	"archive",
];

export interface InboxTopicRule {
	name: string;
	hint: string;
	pattern: RegExp;
	target: TriageTargetKey;
	tag: string;
}

/** 收件箱主题规则：主题分诊图与分诊卡共用这一份。 */
export const INBOX_TOPIC_RULES: readonly InboxTopicRule[] = [
	{ name: "Loop / 循环工程", hint: "适合进洞察或素材聚类", pattern: /loop|循环/i, target: "insights", tag: "loop" },
	{ name: "微信同步", hint: "适合沉淀为自动化模块", pattern: /微信|黑曜石|同步/, target: "assets", tag: "同步" },
	{ name: "AI 控制台", hint: "适合回流 TT工作台", pattern: /控制台|仪表盘|talos/i, target: "projects", tag: "talos" },
	{ name: "Agent 工程", hint: "适合进 Claude / Agent 素材", pattern: /agent|claude|工程/i, target: "assets", tag: "agent" },
];

export const INBOX_FALLBACK_TOPIC = { name: "其他", hint: "需要人工判断" } as const;

/** 返回命中的规则序号；都不命中时返回 INBOX_TOPIC_RULES.length（「其他」）。 */
export function classifyInboxTopic(text: string): number {
	const index = INBOX_TOPIC_RULES.findIndex((rule) => rule.pattern.test(text));
	return index < 0 ? INBOX_TOPIC_RULES.length : index;
}

export interface InboxTriageSuggestion {
	/** 规则给出的目标；null 表示规则无法判断，需要用户改判。 */
	target: TriageTargetKey | null;
	topic: string;
	tags: string[];
}

export function suggestInboxTriage(text: string, existingTags: readonly string[] = []): InboxTriageSuggestion {
	const rule = INBOX_TOPIC_RULES[classifyInboxTopic(text)];
	const tags = [...new Set([...existingTags, ...(rule ? [rule.tag] : [])])];
	return rule
		? { target: rule.target, topic: rule.name, tags }
		: { target: null, topic: INBOX_FALLBACK_TOPIC.name, tags };
}

export interface InboxMovePlan {
	from: string;
	to: string;
	targetKey: TriageTargetKey;
}

export type InboxMovePlanResult =
	| { ok: true; message: string; plan: InboxMovePlan }
	| { ok: false; message: string };

function cleanPath(path: string): string {
	return path.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

function isUnder(path: string, dir: string): boolean {
	return dir.length > 0 && path.startsWith(`${dir}/`);
}

/** 计算「收下」的移动计划：只允许从收件箱移到所选目录根部，且不覆盖同名笔记。 */
export function planInboxMove(input: {
	notePath: string;
	inboxDir: string;
	targetKey: TriageTargetKey;
	targetDir: string;
	existingPaths: ReadonlySet<string>;
}): InboxMovePlanResult {
	const from = cleanPath(input.notePath);
	const inboxDir = cleanPath(input.inboxDir);
	const targetDir = cleanPath(input.targetDir);
	if (!from.toLowerCase().endsWith(".md")) return { ok: false, message: "只能分诊 Markdown 笔记" };
	if (!isUnder(from, inboxDir)) return { ok: false, message: `笔记不在收件箱内：${from}` };
	if (!targetDir || targetDir.split("/").some((part) => part === ".." || part === ".")) {
		return { ok: false, message: "目标目录无效" };
	}
	if (targetDir === inboxDir || isUnder(targetDir, inboxDir)) {
		return { ok: false, message: "目标目录不能在收件箱内" };
	}
	const name = from.slice(from.lastIndexOf("/") + 1);
	const to = `${targetDir}/${name}`;
	if (input.existingPaths.has(to)) return { ok: false, message: `目标已有同名笔记：${to}` };
	return { ok: true, message: `${from} → ${to}`, plan: { from, to, targetKey: input.targetKey } };
}

/** 移动必然是高风险 move，风险策略会给出 propose，必须经用户批准。 */
export function inboxMoveRequest(plan: InboxMovePlan): TalosActionRequest {
	return { readPaths: [plan.from], writePaths: [plan.from, plan.to], effects: ["move"] };
}

/** 「稍后」：把该条移到队尾，只影响本次会话的顺序。 */
export function deferInboxItem(order: readonly string[], path: string): string[] {
	if (!order.includes(path)) return [...order];
	return [...order.filter((item) => item !== path), path];
}
