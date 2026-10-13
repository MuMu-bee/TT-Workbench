import { describe, expect, it } from "vitest";
import {
	INBOX_TOPIC_RULES,
	classifyInboxTopic,
	deferInboxItem,
	inboxMoveRequest,
	planInboxMove,
	suggestInboxTriage,
} from "../src/inbox-triage";
import { createBuiltinActionRegistry } from "../src/action-core/builtin-actions";
import { evaluateActionRisk } from "../src/action-core/risk-policy";

const noop = async () => undefined;

function plan(overrides: Partial<Parameters<typeof planInboxMove>[0]> = {}) {
	return planInboxMove({
		notePath: "00-收件箱/想法 loop.md",
		inboxDir: "00-收件箱",
		targetKey: "insights",
		targetDir: "02-洞察",
		existingPaths: new Set<string>(),
		...overrides,
	});
}

describe("inbox triage pure layer", () => {
	it("keeps the five existing topic buckets and their order", () => {
		expect(INBOX_TOPIC_RULES.map((rule) => rule.name)).toEqual([
			"Loop / 循环工程",
			"微信同步",
			"AI 控制台",
			"Agent 工程",
		]);
		expect(classifyInboxTopic("Loop 复盘")).toBe(0);
		expect(classifyInboxTopic("微信同步方案")).toBe(1);
		expect(classifyInboxTopic("TALOS 仪表盘")).toBe(2);
		expect(classifyInboxTopic("Claude agent 笔记")).toBe(3);
		expect(classifyInboxTopic("随手记")).toBe(INBOX_TOPIC_RULES.length);
	});

	it("suggests a rule target with tags, and asks the user when no rule matches", () => {
		expect(suggestInboxTriage("TALOS 控制台", ["idea"])).toEqual({
			target: "projects",
			topic: "AI 控制台",
			tags: ["idea", "talos"],
		});
		expect(suggestInboxTriage("随手记")).toEqual({ target: null, topic: "其他", tags: [] });
	});

	it("plans a move from the inbox into the chosen directory root", () => {
		expect(plan()).toEqual({
			ok: true,
			message: "00-收件箱/想法 loop.md → 02-洞察/想法 loop.md",
			plan: { from: "00-收件箱/想法 loop.md", to: "02-洞察/想法 loop.md", targetKey: "insights" },
		});
		expect(plan({ notePath: "00-收件箱/子目录/a.md" })).toMatchObject({ ok: true, plan: { to: "02-洞察/a.md" } });
	});

	it("refuses moves that would overwrite, leave the inbox scope or stay in the inbox", () => {
		expect(plan({ existingPaths: new Set(["02-洞察/想法 loop.md"]) })).toEqual({
			ok: false,
			message: "目标已有同名笔记：02-洞察/想法 loop.md",
		});
		expect(plan({ notePath: "02-洞察/x.md" }).ok).toBe(false);
		expect(plan({ targetDir: "00-收件箱/归档" }).ok).toBe(false);
		expect(plan({ targetDir: "../外部" }).ok).toBe(false);
		expect(plan({ notePath: "00-收件箱/图片.png" }).ok).toBe(false);
	});

	it("always lands on propose under the existing risk policy", () => {
		const registry = createBuiltinActionRegistry(
			{
				refreshStats: noop,
				vaultLint: noop,
				deepResearch: noop,
				createNote: noop,
				publishBackfill: noop,
				decideApproval: noop,
				decidePreference: noop,
				moveInboxNote: noop,
			},
			{
				noteWriteScopes: ["00-收件箱/**"],
				inboxTriageReadScopes: ["00-收件箱/**"],
				inboxTriageWriteScopes: ["00-收件箱/**", "02-洞察/**"],
			}
		);
		const definition = registry.get("triage-inbox-note");
		const result = plan();
		if (!definition || !result.ok) throw new Error("fixture");
		const request = inboxMoveRequest(result.plan);
		expect(request).toEqual({
			readPaths: ["00-收件箱/想法 loop.md"],
			writePaths: ["00-收件箱/想法 loop.md", "02-洞察/想法 loop.md"],
			effects: ["move"],
		});
		expect(definition.risk).toBe("C");
		expect(evaluateActionRisk(definition, request).decision).toBe("propose");
	});

	it("defers an item to the end without mutating the input order", () => {
		const order = ["a", "b", "c"];
		expect(deferInboxItem(order, "a")).toEqual(["b", "c", "a"]);
		expect(order).toEqual(["a", "b", "c"]);
		expect(deferInboxItem(order, "missing")).toEqual(order);
	});
});
