// 收件箱「待分诊」面板：逐条卡片 → 收下 / 改判 / 稍后。
// 收下只生成移动计划并展开提案，用户点「批准并执行」后才由受控动作落盘。
import type { RiskDecision, TalosActionRequest } from "../action-core/types";
import {
	deferInboxItem,
	inboxMoveRequest,
	planInboxMove,
	suggestInboxTriage,
	type InboxMovePlan,
	type TriageTargetKey,
} from "../inbox-triage";
import type { InboxQueueItem } from "../types";
import { ProposalPanel } from "./proposal-panel";

export interface InboxTriageTarget {
	key: TriageTargetKey;
	label: string;
	dir: string;
}

export interface InboxTriagePanelOptions {
	parent: HTMLElement;
	items: InboxQueueItem[];
	/** 收件箱笔记总数（队列可能只取了最早的一部分）。 */
	total: number;
	targets: InboxTriageTarget[];
	inboxDir: string;
	existingPaths(): ReadonlySet<string>;
	evaluate(request: TalosActionRequest): RiskDecision;
	onOpen(path: string): void;
	onApprove(plan: InboxMovePlan): Promise<{ ok: boolean; message: string }>;
	/** 一次显示的卡片数。 */
	visible?: number;
	/** 由视图持有的会话状态，页面因数据刷新重绘后「稍后」的顺序仍保留。 */
	session?: InboxTriageSession;
}

export interface InboxTriageSession {
	deferred: readonly string[];
}

export class InboxTriagePanel {
	private root: HTMLElement | null = null;
	private order: string[];
	private readonly items = new Map<string, InboxQueueItem>();
	private readonly choice = new Map<string, TriageTargetKey | null>();
	private readonly topics = new Map<string, string>();
	private readonly tags = new Map<string, string[]>();
	private readonly status = new Map<string, string>();
	private readonly done = new Set<string>();
	private proposalPath: string | null = null;
	private proposal: ProposalPanel | null = null;
	private busy = false;
	/**
	 * Q-PER11：一次「收下」里 propose() 与随后 mountProposal() 会各调一次 planFor()，
	 * 每次都要把整库（含附件）路径映射一遍。按分诊周期缓存，成功移动 / 改判 / 卸载时失效，
	 * 否则 inbox-triage.ts 的撞名判定会读到旧集合而漏判。
	 */
	private existingCache: ReadonlySet<string> | null = null;

	constructor(private readonly options: InboxTriagePanelOptions) {
		const deferred = options.session?.deferred ?? [];
		this.order = deferred.reduce(
			(order, path) => deferInboxItem(order, path),
			options.items.map((item) => item.path)
		);
		for (const item of options.items) {
			const suggestion = suggestInboxTriage(`${basename(item.path)} ${item.title}`, item.tags);
			this.items.set(item.path, item);
			this.choice.set(item.path, suggestion.target);
			this.topics.set(item.path, suggestion.topic);
			this.tags.set(item.path, suggestion.tags);
		}
	}

	mount(): HTMLElement {
		if (this.root) return this.root;
		const root = this.el("section", "inbox-triage");
		root.setAttribute("aria-label", "收件箱待分诊");
		this.options.parent.appendChild(root);
		this.root = root;
		this.render();
		return root;
	}

	unmount(): void {
		this.existingCache = null;
		this.proposal?.unmount();
		this.proposal = null;
		this.root?.remove();
		this.root = null;
	}

	private render(): void {
		const root = this.root;
		if (!root) return;
		this.proposal?.unmount();
		this.proposal = null;
		root.replaceChildren();

		const pending = this.order.filter((path) => !this.done.has(path));
		const visible = pending.slice(0, this.options.visible ?? 5);
		const summary = this.el("p", "inbox-triage__summary");
		summary.textContent = pending.length === 0
			? (this.done.size > 0 ? `本次已归档 ${this.done.size} 条` : "没有待分诊的笔记")
			: `待分诊 ${this.options.total - this.done.size} 条 · 显示最早的 ${visible.length} 条 · 目录为规则建议，不调用模型`;
		root.appendChild(summary);

		const list = this.el("div", "inbox-triage__list");
		for (const path of visible) list.appendChild(this.renderCard(path));
		root.appendChild(list);
	}

	private renderCard(path: string): HTMLElement {
		const item = this.items.get(path) as InboxQueueItem;
		const target = this.choice.get(path) ?? null;
		const card = this.el("article", "inbox-triage-card");
		card.setAttribute("data-path", path);
		if (this.isDeferred(path)) card.setAttribute("data-deferred", "true");

		const head = this.el("div", "inbox-triage-card__head");
		const title = this.button(item.title, "open", () => this.options.onOpen(path));
		title.className = "inbox-triage-card__title";
		head.appendChild(title);
		const meta = this.el("small", "inbox-triage-card__meta");
		meta.textContent = target
			? `${item.ageDays} 天 · 规则建议：${this.topics.get(path)}`
			: `${item.ageDays} 天 · 规则未命中，请选择目录`;
		head.appendChild(meta);
		card.appendChild(head);

		const tags = this.tags.get(path) ?? [];
		if (tags.length > 0) {
			const row = this.el("div", "inbox-triage-card__tags");
			row.setAttribute("aria-label", "建议标签");
			for (const tag of tags) {
				const chip = this.el("span", "inbox-triage-card__tag");
				chip.textContent = `#${tag}`;
				row.appendChild(chip);
			}
			card.appendChild(row);
		}

		if (item.linked.length > 0) {
			const related = this.el("div", "inbox-triage-card__related");
			const label = this.el("span", "inbox-triage-card__related-label");
			label.textContent = "相关笔记";
			related.appendChild(label);
			for (const linked of item.linked) {
				const link = this.button(basename(linked), "open-related", () => this.options.onOpen(linked));
				link.className = "inbox-triage-card__related-link";
				link.setAttribute("title", linked);
				related.appendChild(link);
			}
			card.appendChild(related);
		}

		const controls = this.el("div", "inbox-triage-card__controls");
		const select = this.el("select", "inbox-triage-card__target") as HTMLSelectElement;
		select.setAttribute("data-action", "retarget");
		select.setAttribute("aria-label", `「${item.title}」放到哪个目录`);
		if (!target) select.appendChild(this.option("", "选择目录…"));
		for (const option of this.options.targets) select.appendChild(this.option(option.key, `${option.label} · ${option.dir}`));
		select.value = target ?? "";
		select.addEventListener("change", () => {
			const next = this.options.targets.find((option) => option.key === select.value);
			this.choice.set(path, next ? next.key : null);
			this.topics.set(path, "已改判");
			this.status.delete(path);
			if (this.proposalPath === path) this.proposalPath = null;
			this.existingCache = null;
			this.render();
		});
		controls.appendChild(select);

		const accept = this.button("收下", "accept", () => this.propose(path));
		accept.disabled = !target || this.busy;
		controls.appendChild(accept);
		const later = this.button("稍后", "defer", () => {
			this.order = deferInboxItem(this.order, path);
			const session = this.options.session;
			if (session) session.deferred = [...session.deferred.filter((item) => item !== path), path];
			if (this.proposalPath === path) this.proposalPath = null;
			this.render();
		});
		later.disabled = this.busy;
		controls.appendChild(later);
		card.appendChild(controls);

		const status = this.el("p", "inbox-triage-card__status");
		status.setAttribute("aria-live", "polite");
		status.textContent = this.status.get(path) ?? "";
		card.appendChild(status);

		if (this.proposalPath === path) this.mountProposal(card, path);
		return card;
	}

	private isDeferred(path: string): boolean {
		return this.options.session?.deferred.includes(path) ?? false;
	}

	/** 路径集合按「一次收下」为周期缓存；所有会让库内容变化的入口都把它置空。 */
	private existing(): ReadonlySet<string> {
		if (this.existingCache === null) this.existingCache = this.options.existingPaths();
		return this.existingCache;
	}

	private planFor(path: string): ReturnType<typeof planInboxMove> | null {
		const key = this.choice.get(path);
		const target = this.options.targets.find((option) => option.key === key);
		if (!target) return null;
		return planInboxMove({
			notePath: path,
			inboxDir: this.options.inboxDir,
			targetKey: target.key,
			targetDir: target.dir,
			existingPaths: this.existing(),
		});
	}

	private propose(path: string): void {
		// 新的一次「收下」：重取集合，别拿上一轮的结果判撞名。
		this.existingCache = null;
		const result = this.planFor(path);
		if (!result) return;
		if (!result.ok) {
			this.status.set(path, result.message);
			this.proposalPath = null;
		} else {
			this.status.delete(path);
			this.proposalPath = path;
		}
		this.render();
	}

	private mountProposal(card: HTMLElement, path: string): void {
		const result = this.planFor(path);
		if (!result?.ok) return;
		const plan = result.plan;
		const item = this.items.get(path) as InboxQueueItem;
		const target = this.options.targets.find((option) => option.key === plan.targetKey) as InboxTriageTarget;
		const risk = this.options.evaluate(inboxMoveRequest(plan));
		this.proposal = new ProposalPanel({
			parent: card,
			proposal: {
				title: `归档「${item.title}」`,
				provider: "本地规则 · 不调用模型",
				steps: [
					`从收件箱移出：${plan.from}`,
					`放入${target.label}：${plan.to}`,
					"Obsidian 同步更新指向它的链接",
				],
				fileCount: 1,
				keyDiffs: [`${plan.from} → ${plan.to}`, `风险判定：${risk.decision === "propose" ? "需要你批准" : risk.decision} · ${risk.reason}`],
				reversible: true,
			},
			onReject: () => {
				this.proposalPath = null;
				this.render();
			},
			onViewDiff: () => {
				this.status.set(path, `移动：${plan.from} → ${plan.to}`);
				this.render();
			},
			onApprove: () => void this.approve(path, plan),
		});
		this.proposal.mount();
	}

	private async approve(path: string, plan: InboxMovePlan): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.proposalPath = null;
		// 移动成功后库里的路径集合会变，缓存必须失效（与下面的 result.ok 同一次「收下」）。
		this.existingCache = null;
		this.status.set(path, "正在归档…");
		this.render();
		try {
			const result = await this.options.onApprove(plan);
			if (result.ok) {
				this.done.add(path);
				this.existingCache = null;
			}
			this.status.set(path, result.message);
		} catch (error) {
			this.status.set(path, error instanceof Error ? error.message : String(error));
		} finally {
			this.busy = false;
			this.render();
		}
	}

	private el(tag: string, className: string): HTMLElement {
		const element = this.options.parent.ownerDocument.createElement(tag);
		element.className = className;
		return element;
	}

	private button(label: string, action: string, onClick: () => void): HTMLButtonElement {
		const button = this.el("button", "inbox-triage-card__action") as HTMLButtonElement;
		button.type = "button";
		button.setAttribute("data-action", action);
		button.textContent = label;
		button.addEventListener("click", onClick);
		return button;
	}

	private option(value: string, label: string): HTMLOptionElement {
		const option = this.el("option", "") as HTMLOptionElement;
		option.value = value;
		option.textContent = label;
		return option;
	}
}

function basename(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	return name.replace(/\.md$/i, "");
}
