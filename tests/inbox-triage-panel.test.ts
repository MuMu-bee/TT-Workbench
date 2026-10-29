import { describe, expect, it, vi } from "vitest";
import type { InboxMovePlan } from "../src/inbox-triage";
import { InboxTriagePanel, type InboxTriageSession } from "../src/ui/inbox-triage-panel";
import type { InboxQueueItem } from "../src/types";
import { createMiniHost, type MiniElement } from "./helpers/mini-dom";

const items: InboxQueueItem[] = [
	{ path: "00-收件箱/loop 复盘.md", title: "loop 复盘", ageDays: 12, tags: ["复盘"], linked: ["02-洞察/循环.md"] },
	{ path: "00-收件箱/随手记.md", title: "随手记", ageDays: 3, tags: [], linked: [] },
];

/**
 * Q-PER11 撞名用例专用夹具：前两条与 `items` 相同，第三条是同 basename 的
 * `00-收件箱/子目录/loop 复盘.md`。默认夹具保持 2 条，既有断言（卡片数、`待分诊 1 条`、
 * 「稍后」顺序）都不受影响。
 */
const itemsWithDuplicateBasename: InboxQueueItem[] = [
	...items,
	{ path: "00-收件箱/子目录/loop 复盘.md", title: "loop 复盘", ageDays: 5, tags: ["复盘"], linked: [] },
];

const targets = [
	{ key: "insights" as const, label: "洞察", dir: "02-洞察" },
	{ key: "assets" as const, label: "素材", dir: "03-素材" },
];

function setup(overrides: {
	// 显式对齐 InboxTriagePanel 的 onApprove 契约
	// （inbox-triage-panel.ts:31 → (plan: InboxMovePlan) => Promise<{ok, message}>），
	// 这样传进来的 mock 也有参数类型，不需要 cast。
	onApprove?: (plan: InboxMovePlan) => Promise<{ ok: boolean; message: string }>;
	existing?: Set<string>;
	/** 有状态夹具：existingPaths 直接读这个集合，approve 后由用例往里加 plan.to。 */
	existingSet?: Set<string>;
	session?: InboxTriageSession;
	/** 撞名用例要第三篇同 basename 的条目；默认仍是 2 条，既有断言不受影响。 */
	queue?: InboxQueueItem[];
} = {}) {
	const { host, element } = createMiniHost();
	const queue = overrides.queue ?? items;
	const onApprove = overrides.onApprove ?? vi.fn(async (_plan: InboxMovePlan) => ({ ok: true, message: "已归档" }));
	const onOpen = vi.fn();
	const evaluate = vi.fn(() => ({ decision: "propose" as const, reason: "高风险影响" }));
	const existingPaths = vi.fn(
		() => overrides.existingSet ?? overrides.existing ?? new Set<string>()
	);
	const panel = new InboxTriagePanel({
		parent: host,
		items: queue,
		total: 2,
		targets,
		inboxDir: "00-收件箱",
		existingPaths,
		evaluate,
		onOpen,
		onApprove,
		session: overrides.session,
	});
	panel.mount();
	const cards = () => element.querySelectorAll(".inbox-triage-card");
	const card = (path: string) => cards().find((item) => item.getAttribute("data-path") === path) as MiniElement;
	const action = (scope: MiniElement, name: string) => scope.querySelector(`[data-action="${name}"]`) as MiniElement;
	return { element, onApprove, onOpen, evaluate, existingPaths, cards, card, action };
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

	it("resolves the vault path set once per 收下 instead of once per plan", () => {
		// Q-PER11：propose() 与随后 mountProposal() 各调一次 planFor()，原来两次都重算整库路径。
		const { card, action, existingPaths } = setup();
		action(card(items[0].path), "accept").click();
		expect(existingPaths).toHaveBeenCalledTimes(1);
	});

	it("invalidates the cached path set after a successful move so 撞名 is still caught", async () => {
		// 有状态的假库：approve 成功后把 plan.to 加进集合，第 2 篇同名笔记必须撞名（inbox-triage.ts:94）。
		const existingSet = new Set<string>();
		const onApprove = vi.fn(async (plan: InboxMovePlan) => {
			existingSet.add(plan.to);
			return { ok: true, message: `已归档到 ${plan.to}` };
		});
		const { card, action, element, existingPaths } = setup({ onApprove, existingSet, queue: itemsWithDuplicateBasename });

		// 第 1 篇：收下 → 提案里批准 → 真的落库。
		action(card(items[0].path), "accept").click();
		(element.querySelector('[data-action="approve"]') as MiniElement).click();
		await flush();
		expect(onApprove).toHaveBeenCalledTimes(1);
		expect(existingSet.has("02-洞察/loop 复盘.md")).toBe(true);

		// 第 2 篇（同 basename）：缓存若未失效就会漏判，这里必须看到撞名提示。
		const duplicate = itemsWithDuplicateBasename[2].path;
		action(card(duplicate), "accept").click();
		expect(card(duplicate).textContent).toContain("目标已有同名笔记：02-洞察/loop 复盘.md");
		expect(element.querySelector(".talos-proposal-panel")).toBeNull();

		// 两次「收下」合计只做 2 次缓存未命中（无缓存时是 3 次：propose + mountProposal + 第二次 propose）。
		expect(existingPaths).toHaveBeenCalledTimes(2);
	});
});
