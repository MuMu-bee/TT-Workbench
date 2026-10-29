// Lens 的资料浏览样式：搜索框 → 分类芯片 → 分页卡片（lens-card-deck，每页 6 张）→ 点击右侧摘要栏。
// 收集 / 知识 / 身份 / 输出 / 执行节奏的笔记列表都走这一套。
import { TFile } from "obsidian";
import type { MetricTile, SignalItem } from "../../types";
import { button, chip, el, heading, icon, panel, type LensChild } from "./lens-dom";
import { bytes, num, time } from "./lens-format";
import { listNotes, type LensNote } from "./lens-data";
import type { LensContext } from "./lens-pages";

const CARD_PAGE_SIZE = 6;

function searchBox(ctx: LensContext, key: string, placeholder: string): HTMLElement {
	const { doc } = ctx;
	const input = el(doc, "input", { id: `lens-q-${key}`, type: "search", "aria-label": placeholder, placeholder });
	input.value = ctx.state.queries[key] ?? "";
	input.addEventListener("input", () => {
		// 状态立刻写（不高滞后期望值），只把重绘合并到一个窗口里（Q-PER9）。
		ctx.state.queries[key] = input.value;
		ctx.state.deckPages[key] = 0;
		ctx.rerenderDebounced();
	});
	// 失焦 / 回车（change）时把待处理的重绘立刻打出来，避免「输入了但列表没变」。
	input.addEventListener("change", () => ctx.flushRerender());
	return el(doc, "label", { class: "ta-search" }, icon(doc, "search"), input);
}

function readingCard(ctx: LensContext, note: LensNote, kind: string): HTMLElement {
	const { doc } = ctx;
	const card = el(doc, "button", {
		type: "button",
		class: `lens-reading-card${ctx.drawerPath() === note.path ? " is-selected" : ""}`,
		"data-doc": note.path,
		title: note.name,
	},
	el(doc, "span", { class: "lens-card-symbol" }, icon(doc, "file-text")),
	el(doc, "h3", {}, note.name),
	el(doc, "span", { class: "lens-card-meta" }, chip(doc, kind, "dim"), el(doc, "span", {}, note.folder || note.tags[0] || "根目录")),
	el(doc, "span", { class: "lens-card-meta" }, el(doc, "span", {}, `修改 ${time(note.mtime, true)}`), el(doc, "span", {}, bytes(note.size)), icon(doc, "chevron-right")));
	card.addEventListener("click", () => ctx.openDrawer(note.path));
	return card;
}

function cardDeck(ctx: LensContext, key: string, label: string, cards: HTMLElement[]): HTMLElement {
	const { doc } = ctx;
	const total = cards.length;
	const pages = Math.max(1, Math.ceil(total / CARD_PAGE_SIZE));
	const page = Math.max(0, Math.min(pages - 1, ctx.state.deckPages[key] ?? 0));
	const start = page * CARD_PAGE_SIZE;
	const end = Math.min(total, start + CARD_PAGE_SIZE);
	const turn = (delta: number) => {
		ctx.state.deckPages[key] = page + delta;
		ctx.rerender();
	};
	const prev = button(doc, "← 上一页", { "aria-label": `上一页 · ${label}`, disabled: page === 0 });
	prev.addEventListener("click", () => turn(-1));
	const next = button(doc, "下一页 →", { "aria-label": `下一页 · ${label}`, disabled: page === pages - 1 });
	next.addEventListener("click", () => turn(1));
	return el(doc, "section", {
		class: "lens-card-deck", "data-card-deck": key, "data-card-page": page, "data-card-pages": pages, "data-card-busy": "false",
		"aria-label": label, "aria-roledescription": "分页卡片", tabindex: "0",
	},
	el(doc, "div", { class: "lens-deck-header" }, el(doc, "span", {}, label, el(doc, "small", {}, `${total} 项 · ${total ? start + 1 : 0}–${end}`))),
	el(doc, "div", { class: "lens-deck-window" },
		el(doc, "div", { class: "lens-card-page", "data-direction": "0", "aria-busy": "false" },
			...(total ? cards.slice(start, end) : [el(doc, "p", { class: "lens-card-empty" }, "当前范围没有内容。")]))),
	el(doc, "nav", { class: "lens-deck-controls", "aria-label": `${label}翻页` },
		prev, el(doc, "span", { class: "lens-page-indicator", role: "status", "aria-live": "polite" }, "第 ", el(doc, "b", {}, String(page + 1)), ` / ${pages} 页`), next));
}

/** 目录笔记卡片：搜索 + 子目录芯片 + 分页卡片。 */
export function noteDeck(ctx: LensContext, key: string, label: string, folder: string, kind = label): HTMLElement {
	const { doc } = ctx;
	const all = listNotes(ctx.app, folder, { skipReadme: true, generation: ctx.data.capturedAt });
	const query = (ctx.state.queries[key] ?? "").trim().toLowerCase();
	const filterKey = `${key}:kind`;
	const activeKind = ctx.state.queries[filterKey] ?? "all";
	const groups = new Map<string, number>();
	for (const note of all) {
		const group = note.folder.split("/")[0] || "根目录";
		groups.set(group, (groups.get(group) ?? 0) + 1);
	}
	const matches = all.filter((note) =>
		(activeKind === "all" || (note.folder.split("/")[0] || "根目录") === activeKind)
		&& (!query || `${note.name} ${note.folder} ${note.tags.join(" ")}`.toLowerCase().includes(query)));
	const chips = groups.size > 1 ? el(doc, "div", { class: "lens-kind-chips", role: "group", "aria-label": "按目录筛选" },
		...[["all", "全部", all.length] as const, ...[...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => [name, name, count] as const)]
			.map(([id, name, count]) => {
				const node = el(doc, "button", { type: "button", class: "lens-kind-chip", "aria-pressed": String(activeKind === id) }, name, el(doc, "b", {}, num(count)));
				node.addEventListener("click", () => {
					ctx.state.queries[filterKey] = id;
					ctx.state.deckPages[key] = 0;
					ctx.rerender();
				});
				return node;
			})) : null;
	return el(doc, "div", { class: "lens-note-browser" },
		searchBox(ctx, key, `搜索${label}的标题、目录或标签`),
		chips,
		cardDeck(ctx, key, `${label}卡片`, matches.map((note) => readingCard(ctx, note, kind))));
}

/** 已采集的条目列表（待发、候选等）也用卡片展示，能定位到文件的打开摘要栏。 */
export function signalDeck(ctx: LensContext, key: string, label: string, items: SignalItem[], kind: string): HTMLElement {
	const notes: LensNote[] = items.map((item) => {
		const file = item.path ? ctx.app.vault.getAbstractFileByPath(item.path) : null;
		return file instanceof TFile
			? { path: file.path, name: item.title, folder: item.meta, mtime: file.stat.mtime, size: file.stat.size, tags: [] }
			: { path: item.path ?? "", name: item.title, folder: item.meta, mtime: 0, size: 0, tags: [] };
	});
	return cardDeck(ctx, key, label, notes.map((note) => readingCard(ctx, note, kind)));
}

/** MetricTile 指标用 Lens 的 ov-kpis 指标条呈现。 */
export function metricStrip(ctx: LensContext, metrics: MetricTile[]): HTMLElement {
	const { doc } = ctx;
	const tone = { warn: "warn", hot: "fail", good: "pass", default: "idle" } as const;
	return el(doc, "section", { class: "ov-kpiwrap" }, el(doc, "div", { class: "ov-kpis" }, ...metrics.slice(0, 5).map((m, i) => {
		const node = el(doc, "button", { type: "button", class: "ov-kpi vk-rise", style: `--vk-i:${i}`, "data-missing": String(m.value === "—") },
			el(doc, "span", {}, m.label), el(doc, "strong", {}, m.value), m.sub ? el(doc, "em", { "data-tone": tone[m.tone ?? "default"] }, m.aux || m.sub) : null);
		if (m.path) node.addEventListener("click", () => ctx.openDrawer(m.path!));
		return node;
	})));
}

/** Lens 类型分布行（lens-distribution）。 */
export function distribution(ctx: LensContext, rows: Array<{ name: string; count: number; onClick?: () => void }>, caption: string): LensChild[] {
	const { doc } = ctx;
	const total = rows.reduce((n, r) => n + r.count, 0);
	if (!rows.length || !total) return [el(doc, "p", { class: "lens-query-error" }, "当前范围没有记录。")];
	return [
		el(doc, "div", { class: "lens-distribution" }, ...rows.map((row) => {
			const percent = (row.count / total) * 100;
			const node = el(doc, "button", { type: "button", class: "lens-distribution-row", "aria-label": `${row.name}，${num(row.count)}，占 ${percent.toFixed(1)}%` },
				el(doc, "span", {}, row.name), el(doc, "span", { class: "lens-bar-track" }, el(doc, "i", { style: `width:${percent}%` })),
				el(doc, "b", {}, num(row.count)), el(doc, "small", {}, `${percent.toFixed(1)}%`));
			if (row.onClick) node.addEventListener("click", row.onClick);
			return node;
		})),
		el(doc, "div", { class: "v-caption" }, caption.replace("{total}", num(total))),
	];
}

export function renderCollect(ctx: LensContext): LensChild[] {
	const { doc } = ctx;
	const inbox = ctx.data.collected.inbox;
	if (ctx.tab === "backlog") {
		return [
			heading(doc, "积压分布", `共 ${num(inbox.count)} 条 · 最久 ${inbox.oldestDays} 天`, "收集"),
			panel(doc, "按存放时长", distribution(ctx, inbox.ageBuckets.map((b) => ({ name: b.label, count: b.count })), "共 {total} 条收件")),
			panel(doc, "按主题聚类", distribution(ctx, inbox.clusters.map((c) => ({ name: c.name, count: c.count })), "按标题关键词粗分，共 {total} 条")),
		];
	}
	return [
		heading(doc, "收件箱", "先处理最久的，再归档到洞察或素材", "收集"),
		noteDeck(ctx, "collect", "收件", ctx.paths.dir("inbox")),
	];
}

export function renderKnowledge(ctx: LensContext): LensChild[] {
	const { doc } = ctx;
	const k = ctx.data.collected.knowledge;
	const strip = metricStrip(ctx, k.metrics);
	if (ctx.tab === "materials") return [heading(doc, "素材", "外部收集的资料与摘录", "知识"), strip, noteDeck(ctx, "materials", "素材", ctx.paths.dir("assets"))];
	if (ctx.tab === "moc") return [heading(doc, "MOC", "概念入口与知识地图", "知识"), strip, noteDeck(ctx, "moc", "MOC", ctx.paths.mocDir)];
	return [heading(doc, "洞察", "原创思考与方法论", "知识"), strip, noteDeck(ctx, "insights", "洞察", ctx.paths.dir("insights"))];
}

export function renderIdentity(ctx: LensContext): LensChild[] {
	const { doc } = ctx;
	if (ctx.tab === "soul") return [heading(doc, "人格", "屈原的宪法、记忆账本与说话方式", "身份"), noteDeck(ctx, "soul", "人格", ctx.paths.dir("soul"))];
	return [heading(doc, "身份上下文", "TELOS、PROFILE、CONTEXT 与决策记录", "身份"), noteDeck(ctx, "identity", "身份", ctx.paths.dir("identity"))];
}

export function renderOutput(ctx: LensContext): LensChild[] {
	const { doc } = ctx;
	const o = ctx.data.collected.output;
	const strip = metricStrip(ctx, o.metrics);
	if (ctx.tab === "platforms") {
		return [
			heading(doc, "发布平台", "各平台已发与待发数量", "输出"), strip,
			panel(doc, "已发布", distribution(ctx, o.platforms.map((p) => ({ name: p.name, count: p.published, onClick: () => ctx.openDrawer(p.readme) })), "共 {total} 篇已发布")),
			panel(doc, "待发布", distribution(ctx, o.platforms.map((p) => ({ name: p.name, count: p.pending, onClick: () => ctx.openDrawer(p.readme) })), "共 {total} 篇待发布")),
		];
	}
	if (ctx.tab === "ops") return [heading(doc, "运营候选", "可以转成内容的运营素材", "输出"), strip, signalDeck(ctx, "ops", "运营候选", o.opsCandidates, "候选")];
	return [heading(doc, "待发", "已写好、等待发布的内容", "输出"), strip, signalDeck(ctx, "queue", "待发内容", o.queue, "待发")];
}
