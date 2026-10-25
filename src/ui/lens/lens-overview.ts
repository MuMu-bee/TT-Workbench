// Lens「总览」：结构逐段对照 TALOS Lens visuals.overview()——问候页头、指标条与项目矩阵、
// 焦点项目卡（阶段轨道 + 下一步 + 检查点）、今日简报（一句结论 + 按原因排序）、接下来、活跃时间轴。
// 数据换成超级大脑：收件、审批、待发布、健康分、lili 状态快照与 04-项目。
import { chip, el, heading, icon, link, meter, panel, type LensChild } from "./lens-dom";
import { CHECK_TONE, STAGES, STATUS_TONE, freshness, greeting, label, num, stageIndex, time } from "./lens-format";
import type { LensContext } from "./lens-pages";
import type { LensFocus, LensProject } from "./lens-data";
import { noteDeck } from "./lens-library";

function freshnessDot(ctx: LensContext, value: number | string | null | undefined): HTMLElement {
	const f = freshness(value);
	return el(ctx.doc, "span", { class: "vk-fresh", "data-tone": f.tone, title: typeof value === "string" ? value : "" }, el(ctx.doc, "i"), f.label);
}

function onClick<T extends HTMLElement>(node: T, action: () => void): T {
	node.addEventListener("click", action);
	return node;
}

function healthScore(ctx: LensContext): { value: string; warn: boolean } {
	const metric = ctx.data.collected.healthDigest.metrics.find((m) => m.label === "健康分");
	return { value: metric?.value ?? "—", warn: metric?.tone === "warn" };
}

function staleInbox(ctx: LensContext): number {
	return ctx.data.collected.inbox.ageBuckets.filter((b) => b.tone === "hot" || b.tone === "warn").reduce((n, b) => n + b.count, 0);
}

function kpiStrip(ctx: LensContext): HTMLElement {
	const { doc, data } = ctx;
	const d = data.collected;
	const projects = data.projects;
	const active = projects.filter((p) => p.status === "active").length;
	const health = healthScore(ctx);
	const items: Array<[string, string, [string, string] | null, () => void]> = [
		["登记项目", num(projects.length), active ? [`${active} 推进中`, "c5"] : null, () => ctx.navigate("projects")],
		["收件待处理", num(d.inbox.count), d.inbox.oldestDays >= 14 ? [`最久 ${d.inbox.oldestDays} 天`, "warn"] : null, () => ctx.navigate("collect")],
		["待审批", num(d.approvals.length), d.approvals.length ? ["需你确认", "fail"] : null, () => ctx.navigate("system", "approvals")],
		["待发布", num(d.output.queue.length), null, () => ctx.navigate("output", "queue")],
		["健康分", health.value, health.warn ? ["需关注", "warn"] : null, () => ctx.navigate("system", "health")],
	];
	const kpis = el(doc, "div", { class: "ov-kpis" }, ...items.map(([name, value, pill, go], i) =>
		onClick(el(doc, "button", { type: "button", class: "ov-kpi vk-rise", style: `--vk-i:${i}`, "data-missing": String(value === "—") },
			el(doc, "span", {}, name),
			el(doc, "strong", { "data-count": `ov-kpi-${i}` }, value),
			value === "—" ? el(doc, "em", { "data-tone": "idle" }, "未读取") : pill ? el(doc, "em", { "data-tone": pill[1] }, pill[0]) : null), go)));

	const counts = new Map<string, number>();
	for (const p of projects) counts.set(p.status, (counts.get(p.status) ?? 0) + 1);
	const matrix = projects.length ? el(doc, "div", { class: "ov-matrixrow" },
		el(doc, "div", { class: "lv-matrix", "data-matrix": "", "aria-label": `项目矩阵：${projects.length} 个项目` },
			...projects.map((p, i) => {
				const f = freshness(p.lastUpdated);
				return onClick(el(doc, "button", {
					type: "button", class: "lv-tile", style: `--i:${i}`, "data-tone": STATUS_TONE[p.status] ?? "idle",
					"data-status": p.status, "data-blocked": "false", "data-age": f.tone,
					"data-tip": `${p.name} · ${label(p.status)} · ${f.label}`, "aria-label": p.name,
				}), () => ctx.navigate("projects"));
			})),
		el(doc, "div", { class: "ov-matrixlegend" },
			...[...counts.entries()].map(([status, count]) => onClick(el(doc, "button", { type: "button", "aria-label": `查看${label(status)}的 ${count} 个项目` },
				el(doc, "i", { "data-tone": STATUS_TONE[status] ?? "idle" }), label(status), el(doc, "b", {}, num(count))), () => {
				ctx.state.projectFilter = status;
				ctx.navigate("projects");
			})))) : null;
	return el(doc, "section", { class: "ov-kpiwrap" }, kpis, matrix);
}

function focusCard(ctx: LensContext, focus: LensFocus | null): HTMLElement {
	const { doc } = ctx;
	if (!focus) {
		return el(doc, "section", { class: "ov-focus ov-card" },
			el(doc, "p", { class: "lens-overview-hint" }, ctx.data.peerState === "disabled" ? "TT 状态桥已关闭；在设置里开启后显示焦点项目。" : "lili 状态快照尚未生成，暂时没有焦点项目。"));
	}
	const at = stageIndex(focus.status);
	const priority = /^P[0-4]$/i.test(focus.priority) ? el(doc, "em", { "data-tone": "ink" }, focus.priority.toUpperCase()) : null;
	const blocked = focus.blockers.length ? el(doc, "em", { "data-tone": "fail" }, `${focus.blockers.length} 条阻碍`) : null;
	const track = el(doc, "div", { class: "ov-track", style: `--ov-at:${Math.max(0, at)}` },
		...STAGES.map(([, name], i) => el(doc, "span", { class: "ov-stop", "data-done": String(at >= 0 && i <= at), "data-current": String(i === at) }, el(doc, "i"), name)));
	const checks = el(doc, "span", { class: "ov-checks" },
		...[["build", "构建"], ["tests", "测试"], ["install", "安装"], ["launch", "启动"], ["user_validation", "验收"]].map(([id, name]) => {
			const value = focus.checkpoint[id] ?? "unknown";
			return el(doc, "span", { class: "ov-checkpill", "data-tone": CHECK_TONE[value] ?? "idle", title: `${name} · ${label(value)}` }, el(doc, "i"), name);
		}));
	return onClick(el(doc, "button", { type: "button", class: "ov-focus ov-card" },
		el(doc, "span", { class: "ov-eyebrow" }, icon(doc, "route"), "焦点项目", priority, blocked, freshnessDot(ctx, focus.lastUpdated)),
		el(doc, "strong", { class: "ov-focus-name" }, focus.name),
		track,
		el(doc, "span", { class: "ov-next" }, el(doc, "small", {}, "下一步"), el(doc, "span", {}, focus.next)),
		checks), () => ctx.navigate("projects"));
}

interface Reason { key: string; label: string; value: number; max: number; tone: string; go?: () => void }

function briefCard(ctx: LensContext): HTMLElement {
	const { doc, data } = ctx;
	const d = data.collected;
	const blockers = data.focus?.blockers.length ?? 0;
	const stale = staleInbox(ctx);
	const healthIssues = d.healthDigest.errors.length;
	const reasons: Reason[] = [
		blockers ? { key: "blocker", label: "焦点项目存在阻碍", value: blockers, max: Math.max(blockers, 1), tone: "fail" } : null,
		d.approvals.length ? { key: "approvals", label: "变更等待审批", value: d.approvals.length, max: Math.max(d.approvals.length, d.candidates.length, 1), tone: "warn", go: () => ctx.navigate("system", "approvals") } : null,
		stale ? { key: "inbox", label: "收件超过两周未处理", value: stale, max: Math.max(d.inbox.count, 1), tone: "warn", go: () => ctx.navigate("collect", "backlog") } : null,
		d.output.queue.length ? { key: "output", label: "内容等待发布", value: d.output.queue.length, max: Math.max(d.output.queue.length, 1), tone: "c3", go: () => ctx.navigate("output", "queue") } : null,
		healthIssues ? { key: "health", label: "健康项待关注", value: healthIssues, max: Math.max(healthIssues, 1), tone: "warn", go: () => ctx.navigate("system", "health") } : null,
	].filter((r): r is Reason => r !== null);
	const parts = [blockers ? `焦点项目有 ${blockers} 条阻碍` : "", d.approvals.length ? `${d.approvals.length} 项变更等你审批` : ""].filter(Boolean);
	if (!parts.length && stale) parts.push(`${stale} 条收件超过两周未处理`);
	const calm = !parts.length;
	const headline = calm ? "没有登记的阻碍或待审批变更，按计划推进。" : `${parts.join("，")}。`;

	const reasonButtons: LensChild[] = [];
	reasons.forEach((r, i) => {
		const open = ctx.state.ovExpand === r.key;
		const node = el(doc, "button", { type: "button", class: "ov-reason vk-rise", style: `--vk-i:${i}`, ...(r.go ? {} : { "aria-expanded": String(open) }) },
			el(doc, "b", { "data-count": `ov-brief-${r.key}` }, num(r.value)), el(doc, "span", {}, r.label), meter(doc, r.value, r.max, r.tone),
			icon(doc, r.go ? "arrow-up-right" : open ? "chevron-up" : "chevron-down"));
		node.addEventListener("click", () => {
			if (r.go) { r.go(); return; }
			ctx.state.ovExpand = open ? null : r.key;
			ctx.rerender();
		});
		reasonButtons.push(node);
		if (open && r.key === "blocker") {
			reasonButtons.push(el(doc, "div", { class: "ov-drill" }, ...(data.focus?.blockers ?? []).map((b) =>
				onClick(el(doc, "button", { type: "button" }, el(doc, "span", {}, b.title), el(doc, "small", {}, label(b.severity)), icon(doc, "chevron-right")), () => ctx.navigate("projects")))));
		}
	});
	const actions = el(doc, "div", { class: "ov-brief-actions" },
		blockers ? onClick(el(doc, "button", { type: "button", class: "ov-primary" }, icon(doc, "arrow-up-right"), "处理阻碍"), () => ctx.navigate("projects")) : null,
		onClick(el(doc, "button", { type: "button", class: "ov-ghost" }, icon(doc, "shield-check"), "查看健康"), () => ctx.navigate("system", "health")));
	return el(doc, "section", { class: "ov-brief ov-card", "data-calm": String(calm) },
		el(doc, "span", { class: "ov-eyebrow" }, icon(doc, "sparkles"), "今日简报"),
		el(doc, "p", { class: "ov-headline" }, headline),
		reasonButtons.length ? el(doc, "div", { class: "ov-reasons" }, ...reasonButtons) : null,
		actions);
}

const FOCUS_TONE = { hot: "fail", warn: "c3", normal: "c5" } as const;

function todos(ctx: LensContext): HTMLElement | null {
	const { doc } = ctx;
	const items = ctx.data.collected.focus.slice(0, 5);
	if (!items.length) return null;
	return el(doc, "section", { class: "ov-card ov-todos" },
		el(doc, "div", { class: "v-panel-head" }, el(doc, "h2", {}, "接下来"), link(doc, "全部项目", () => ctx.navigate("projects"))),
		...items.map((item, i) => onClick(el(doc, "button", { type: "button", class: "ov-todo vk-rise", style: `--vk-i:${i}` },
			el(doc, "i", { "data-tone": FOCUS_TONE[item.level] }), el(doc, "strong", {}, item.title), el(doc, "span", {}, item.desc || item.doneWhen || "")), () => {
			if (item.path) ctx.openNote(item.path);
		})));
}

function timeline(ctx: LensContext, projects: LensProject[]): HTMLElement | null {
	const { doc } = ctx;
	const now = Date.now();
	const rows = projects.filter((p) => !["archived", "cancelled"].includes(p.status))
		.map((p) => ({ p, age: p.lastUpdated === null ? null : Math.max(0, Math.floor((now - p.lastUpdated) / 86400000)) }))
		.sort((a, b) => a.p.priority.localeCompare(b.p.priority) || (a.age ?? 1e9) - (b.age ?? 1e9))
		.slice(0, 10);
	if (!rows.length) return null;
	const ticks = [60, 45, 30, 15, 0].map((n) => el(doc, "span", { style: `left:${100 - (n / 60) * 100}%` }, n ? `${n} 天前` : "今天"));
	return el(doc, "section", { class: "ov-timeline ov-card" },
		el(doc, "div", { class: "v-panel-head" }, el(doc, "h2", {}, "项目活跃时间轴"), link(doc, "全部项目", () => ctx.navigate("projects"))),
		el(doc, "div", { class: "ov-tl-grid" },
			el(doc, "div", { class: "ov-tl-axis" }, ...ticks),
			...rows.map(({ p, age }) => {
				const position = age === null ? 0 : Math.max(0, Math.min(100, 100 - (age / 60) * 100));
				return onClick(el(doc, "button", { type: "button", class: "ov-tl-row", "data-tip": `${p.name} · ${label(p.status)} · ${freshness(p.lastUpdated).label}` },
					el(doc, "span", { class: "ov-tl-name" }, p.name),
					el(doc, "span", { class: "ov-tl-lane" }, el(doc, "i", { class: "ov-tl-track" }),
						el(doc, "i", { class: "ov-tl-dot", "data-tone": STATUS_TONE[p.status] ?? "idle", "data-outside": String(age === null || age > 60), style: `left:${position}%` }))), () => ctx.navigate("projects"));
			}),
			el(doc, "i", { class: "ov-tl-now", "aria-hidden": "true" })),
		el(doc, "div", { class: "ov-tl-legend" },
			...["planned", "active", "review", "completed", "paused"].map((s) => el(doc, "span", {}, el(doc, "i", { "data-tone": STATUS_TONE[s] }), label(s)))));
}

export function renderOverviewToday(ctx: LensContext): LensChild[] {
	const { doc } = ctx;
	const g = greeting();
	const header = el(doc, "header", { class: "ov-hello" },
		el(doc, "div", {}, el(doc, "small", {}, g.date), el(doc, "h1", {}, `${g.word}，${ctx.profileName}`)),
		el(doc, "div", { class: "lens-scope" }, chip(doc, "本地库", "dim"),
			el(doc, "span", { title: "资料采集时间" }, icon(doc, "refresh-cw"), time(ctx.data.capturedAt)),
			link(doc, "来源", () => ctx.navigate("preferences"))));
	return [
		header,
		kpiStrip(ctx),
		el(doc, "div", { class: "ov-hero" }, focusCard(ctx, ctx.data.focus), briefCard(ctx)),
		todos(ctx),
		timeline(ctx, ctx.data.projects),
	];
}

/** 执行节奏：近 14 天新增笔记柱图（Lens v-columns）+ 日志卡片。 */
export function renderOverviewRhythm(ctx: LensContext): LensChild[] {
	const { doc } = ctx;
	const cells = ctx.data.collected.heatmap.months.flatMap((m) => m.weeks.flat()).filter((c) => c.date).sort((a, b) => a.date.localeCompare(b.date)).slice(-14);
	const max = Math.max(1, ...cells.map((c) => c.count));
	const colors = ["var(--ta-blue-fill)", "var(--ta-dark-fill)"];
	const columns = el(doc, "div", { class: "v-columns" }, ...cells.map((c, i) =>
		el(doc, "button", { type: "button", style: `--bar-color:${colors[i % 2]}`, title: `${c.date} · ${c.count} 篇` },
			el(doc, "b", {}, num(c.count)),
			el(doc, "div", { class: "v-column-track" }, el(doc, "span", { style: `height:${(c.count / max) * 100}%` })),
			el(doc, "span", {}, c.date.slice(5)))));
	return [
		heading(doc, "执行节奏", "最近两周的写作量与日志", "总览"),
		panel(doc, "近 14 天新增笔记", [columns, el(doc, "small", { class: "v-caption" }, `单位：篇 · ${ctx.data.collected.heatmap.meta}`)]),
		noteDeck(ctx, "rhythm-logs", "日志", ctx.paths.dir("logs")),
	];
}
