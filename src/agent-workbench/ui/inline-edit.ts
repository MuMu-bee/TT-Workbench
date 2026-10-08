// 行内编辑共用核心：对话页按钮与编辑器命令走同一条「临时会话改写 → 按行 diff 确认 →
// 选区未变才替换」流程。临时会话用完即标记删除，不留在历史里。
import type { AgentEvent } from "../contracts/agent-events";
import type { NativeComposerDraft } from "./native-composer";

export const DEFAULT_INLINE_INSTRUCTION = "请改写选区，保持原意，只返回替换文本。";

export interface InlineEditService {
	createConversation(title: string): Promise<{ conversationId: string }>;
	executeConversationTurn(conversationId: string, request: NativeComposerDraft): AsyncIterable<AgentEvent>;
	setConversationLifecycle(conversationId: string, lifecycle: "deleted"): Promise<unknown>;
}

function text(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

/** 用临时会话请求替换文本；返回去掉首尾空白的结果，空结果抛错。 */
export async function requestInlineReplacement(
	service: InlineEditService,
	original: string,
	instruction: string,
	draft: Omit<NativeComposerDraft, "input"> = { toolPolicy: { kind: "read-only" } },
): Promise<string> {
	const request: NativeComposerDraft = {
		...draft,
		input: [{ type: "text", text: `${instruction.trim() || DEFAULT_INLINE_INSTRUCTION}\n\n<selection>\n${original}\n</selection>` }],
	};
	const conversation = await service.createConversation("行内编辑预览");
	let replacement = "";
	try {
		for await (const event of service.executeConversationTurn(conversation.conversationId, request)) {
			if (event.type === "assistant.final") replacement = text(event.payload.text, replacement);
			else if (event.type === "assistant.delta") replacement += text(event.payload.text);
		}
	} finally {
		await service.setConversationLifecycle(conversation.conversationId, "deleted");
	}
	if (!replacement.trim()) throw new Error("智能体没有返回替换文本");
	return replacement.trim();
}

export type DiffLine = { kind: "equal" | "delete" | "insert"; text: string };

/** 按行的最长公共子序列 diff；大文本退化为整段删除 + 整段新增，避免 O(n·m) 过大。 */
export function lineDiff(original: string, replacement: string): DiffLine[] {
	const a = original.split("\n");
	const b = replacement.split("\n");
	if (a.length * b.length > 250_000) {
		return [...a.map((line) => ({ kind: "delete" as const, text: line })), ...b.map((line) => ({ kind: "insert" as const, text: line }))];
	}
	const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i -= 1) {
		for (let j = b.length - 1; j >= 0; j -= 1) {
			lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}
	const lines: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) { lines.push({ kind: "equal", text: a[i] }); i += 1; j += 1; }
		else if (lcs[i + 1][j] >= lcs[i][j + 1]) { lines.push({ kind: "delete", text: a[i] }); i += 1; }
		else { lines.push({ kind: "insert", text: b[j] }); j += 1; }
	}
	while (i < a.length) lines.push({ kind: "delete", text: a[i++] });
	while (j < b.length) lines.push({ kind: "insert", text: b[j++] });
	return lines;
}

const PREFIX: Record<DiffLine["kind"], string> = { equal: " ", delete: "-", insert: "+" };

/** 用既有 .claudian-diff-* 视觉 ABI 渲染按行 diff。 */
export function renderInlineDiff(parent: HTMLElement, original: string, replacement: string): void {
	const doc = parent.ownerDocument;
	for (const line of lineDiff(original, replacement)) {
		const row = doc.createElement("div");
		row.className = `claudian-diff-line claudian-diff-${line.kind}`;
		const prefix = doc.createElement("span");
		prefix.className = "claudian-diff-prefix";
		prefix.textContent = PREFIX[line.kind];
		const body = doc.createElement("span");
		body.className = "claudian-diff-text";
		body.textContent = line.text || " ";
		row.append(prefix, body);
		parent.appendChild(row);
	}
}
