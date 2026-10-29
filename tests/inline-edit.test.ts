import { describe, expect, it, vi } from "vitest";
import { createAgentEvent, type AgentEvent } from "../src/agent-workbench/contracts/agent-events";
import { lineDiff, renderInlineDiff, requestInlineReplacement, type InlineEditService } from "../src/agent-workbench/ui/inline-edit";
import { createMiniHost } from "./helpers/mini-dom";

function event(type: AgentEvent["type"], text: string): AgentEvent {
	return createAgentEvent({ eventId: type + text, conversationId: "tmp", turnId: "t", runtimeId: "ohmypi", type, timestamp: "2026-10-08T00:00:00.000Z", payload: { text } });
}

function service(events: AgentEvent[] | Error): InlineEditService & { deleted: string[]; prompts: string[] } {
	const deleted: string[] = [];
	const prompts: string[] = [];
	return {
		deleted,
		prompts,
		createConversation: vi.fn(async () => ({ conversationId: "tmp" })),
		async *executeConversationTurn(_id, request) {
			prompts.push(request.input.map((block) => (block.type === "text" ? block.text : "")).join(""));
			if (events instanceof Error) throw events;
			yield* events;
		},
		setConversationLifecycle: async (id) => { deleted.push(id); },
	};
}

describe("inline edit core", () => {
	it("assembles streamed text, wraps the selection and always deletes the temporary conversation", async () => {
		const svc = service([event("assistant.delta", "新的"), event("assistant.delta", "段落 ")]);
		expect(await requestInlineReplacement(svc, "旧的段落", "")).toBe("新的段落");
		expect(svc.prompts[0]).toBe("请改写选区，保持原意，只返回替换文本。\n\n<selection>\n旧的段落\n</selection>");
		expect(svc.deleted).toEqual(["tmp"]);
	});

	it("prefers the final message and rejects empty results", async () => {
		expect(await requestInlineReplacement(service([event("assistant.delta", "草稿"), event("assistant.final", "定稿")]), "x", "改短")).toBe("定稿");
		const empty = service([event("assistant.final", "  ")]);
		await expect(requestInlineReplacement(empty, "x", "改短")).rejects.toThrow("智能体没有返回替换文本");
		expect(empty.deleted).toEqual(["tmp"]);
	});

	it("cleans up even when the runtime fails", async () => {
		const failing = service(new Error("runtime down"));
		await expect(requestInlineReplacement(failing, "x", "y")).rejects.toThrow("runtime down");
		expect(failing.deleted).toEqual(["tmp"]);
	});

	it("diffs by line so unchanged paragraphs stay visible", () => {
		expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
			{ kind: "equal", text: "a" },
			{ kind: "delete", text: "b" },
			{ kind: "insert", text: "B" },
			{ kind: "equal", text: "c" },
			{ kind: "insert", text: "d" },
		]);
	});

	it("renders rows with the existing diff classes", () => {
		const { host, element } = createMiniHost();
		renderInlineDiff(host, "旧", "新");
		const rows = element.children;
		expect(rows.map((row) => row.className)).toEqual(["claudian-diff-line claudian-diff-delete", "claudian-diff-line claudian-diff-insert"]);
		expect(rows.map((row) => row.textContent)).toEqual(["-旧", "+新"]);
	});
});
