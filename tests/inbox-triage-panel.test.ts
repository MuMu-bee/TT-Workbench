import { describe, expect, it, vi } from "vitest";
import { InboxTriagePanel, type InboxTriageSession } from "../src/ui/inbox-triage-panel";
import type { InboxQueueItem } from "../src/types";
import { createMiniHost, type MiniElement } from "./helpers/mini-dom";

const items: InboxQueueItem[] = [
	{ path: "00-收件箱/loop 复盘.md", title: "loop 复盘", ageDays: 12, tags: ["复盘"], linked: ["02-洞察/循环.md"] },
	{ path: "00-收件箱/随手记.md", title: "随手记", ageDays: 3, tags: [], linked: [] },
];

const targets = [
	{ key: "insights" as const, label: "洞察", dir: "02-洞察" },
	{ key: "assets" as const, label: "素材", dir: "03-素材" },
];

function setup(overrides: { onApprove?: ReturnType<typeof vi.fn>; existing?: Set<string>; session?: InboxTriageSession } = {}) {
	const { host, element } = createMiniHost();
	const onApprove = overrides.onApprove ?? vi.fn(async () => ({ ok: true, message: "已归档" }));
	const onOpen = vi.fn();
	const evaluate = vi.fn(() => ({ decision: "propose" as const, reason: "高风险影响" }));
	const panel = new InboxTriagePanel({
		parent: host,
		items,
		total: 2,
		targets,
		inboxDir: "00-收件箱",
		existingPaths: () => overrides.existing ?? new Set<string>(),
		evaluate,
		onOpen,
		onApprove,
		session: overrides.session,
	});
	panel.mount();
	const cards = () => element.querySelectorAll(".inbox-triage-card");
	const card = (path: string) => cards().find((item) => item.getAttribute("data-path") === path) as MiniElement;
	const action = (scope: MiniElement, name: string) => scope.querySelector(`[data-action="${name}"]`) as MiniElement;
	return { element, onApprove, onOpen, evaluate, cards, card, action };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("InboxTriagePanel", () => {
	it("renders one card per queued note with rule suggestion, tags and related notes", () => {
		const { cards, card, element } = setup();
		expect(cards()).toHaveLength(2);
		const first = card(items[0].path);
		expect(first.textContent).toContain("12 天 · 规则建议：Loop / 循环工程");
		expect(first.textContent).toContain("#复盘");
		expect(first.textContent).toContain("#loop");
		expect(first.textContent).toContain("相关笔记");
		expect(element.textContent).toContain("目录为规则建议，不调用模型");
	});

	it("disables 收下 until the user picks a directory for an unmatched note", () => {
		const { card, action } = setup();
		const unmatched = card(items[1].path);
		expect(unmatched.textContent).toContain("规则未命中，请选择目录");
		expect(action(unmatched, "accept").disabled).toBe(true);
		const select = action(unmatched, "retarget");
		select.value = "assets";
		select.dispatch("change");
		expect(action(card(items[1].path), "accept").disabled).toBe(false);
	});

	it("收下 only opens a proposal; nothing moves until 批准并执行", async () => {
		const { card, action, onApprove, evaluate, element } = setup();
		action(card(items[0].path), "accept").click();
		expect(onApprove).not.toHaveBeenCalled();
		expect(evaluate).toHaveBeenCalledWith({
			readPaths: [items[0].path],
			writePaths: [items[0].path, "02-洞察/loop 复盘.md"],
			effects: ["move"],
		});
		const proposal = element.querySelector(".talos-proposal-panel") as MiniElement;
		expect(proposal.textContent).toContain("00-收件箱/loop 复盘.md → 02-洞察/loop 复盘.md");
		expect(proposal.textContent).toContain("需要你批准");
		(proposal.querySelector('[data-action="approve"]') as MiniElement).click();
		await flush();
		expect(onApprove).toHaveBeenCalledWith({ from: items[0].path, to: "02-洞察/loop 复盘.md", targetKey: "insights" });
		expect(card(items[0].path)).toBeUndefined();
		expect(element.querySelector(".inbox-triage__summary")?.textContent).toContain("待分诊 1 条");
	});

	it("rejecting the proposal leaves the note in place", () => {
		const { card, action, onApprove, element } = setup();
		action(card(items[0].path), "accept").click();
		(element.querySelector('[data-action="reject"]') as MiniElement).click();
		expect(element.querySelector(".talos-proposal-panel")).toBeNull();
		expect(onApprove).not.toHaveBeenCalled();
		expect(card(items[0].path)).toBeDefined();
	});

	it("shows the plan error instead of a proposal when the target already exists", () => {
		const { card, action, element } = setup({ existing: new Set(["02-洞察/loop 复盘.md"]) });
		action(card(items[0].path), "accept").click();
		expect(element.querySelector(".talos-proposal-panel")).toBeNull();
		expect(card(items[0].path).textContent).toContain("目标已有同名笔记");
	});

	it("keeps a failed move visible with its reason", async () => {
		const onApprove = vi.fn(async () => ({ ok: false, message: "收件箱笔记已不存在" }));
		const { card, action, element } = setup({ onApprove });
		action(card(items[0].path), "accept").click();
		(element.querySelector('[data-action="approve"]') as MiniElement).click();
		await flush();
		expect(card(items[0].path).textContent).toContain("收件箱笔记已不存在");
	});

	it("稍后 moves the card to the end and remembers it for the next render", () => {
		const session: InboxTriageSession = { deferred: [] };
		const first = setup({ session });
		first.action(first.card(items[0].path), "defer").click();
		expect(first.cards().map((item) => item.getAttribute("data-path"))).toEqual([items[1].path, items[0].path]);
		expect(session.deferred).toEqual([items[0].path]);
		const again = setup({ session });
		expect(again.cards().map((item) => item.getAttribute("data-path"))).toEqual([items[1].path, items[0].path]);
	});

	it("opens the note and related notes in place", () => {
		const { card, action, onOpen } = setup();
		action(card(items[0].path), "open").click();
		action(card(items[0].path), "open-related").click();
		expect(onOpen).toHaveBeenNthCalledWith(1, items[0].path);
		expect(onOpen).toHaveBeenNthCalledWith(2, "02-洞察/循环.md");
	});
});
