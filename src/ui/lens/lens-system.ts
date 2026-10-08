// Lens「系统」与「设置」：顶部维护概况条（lens-maintenance-summary），下面按页签展示
// 健康、审批、能力与全库。审批只做浏览与定位，处理仍在原文件里进行（不新增写库入口）。
import { el, heading, icon, panel, section, type LensChild } from "./lens-dom";
import { num, time } from "./lens-format";
import { distribution, metricStrip, signalDeck } from "./lens-library";
import type { LensContext } from "./lens-pages";

function maintenanceSummary(ctx: LensContext): HTMLElement {
	const { doc } = ctx;
	const d = ctx.data.collected;
	const score = d.healthDigest.metrics.find((m) => m.label === "健康分")?.value ?? "—";
	return el(doc, "div", { class: "lens-maintenance-summary", "aria-label": "维护概况" },
		el(doc, "span", {}, icon(doc, "activity"), `健康分 ${score}`),
		el(doc, "span", {}, icon(doc, "scan-line"), `错误模式 ${d.healthDigest.errors.length} 条`),
		el(doc, "span", {}, icon(doc, "badge-check"), `待审批 ${d.approvals.length} 项`),
		el(doc, "small", {}, `数据采集 ${time(ctx.data.capturedAt)} · 健康分取自 health-log`));
}

export function renderSystem(ctx: LensContext): LensChild[] {
	const { doc } = ctx;
	const d = ctx.data.collected;
	const summary = maintenanceSummary(ctx);
	if (ctx.tab === "approvals") {
		return [summary,
			heading(doc, "审批", "B/C 类变更与偏好候选；点开定位原文件处理", "系统"),
			signalDeck(ctx, "approvals", "待审批变更", d.approvals, "待审批"),
			signalDeck(ctx, "candidates", "偏好候选", d.candidates, "候选")];
	}
	if (ctx.tab === "capability") {
		return [summary,
			heading(doc, "能力", `${d.capGroups.reduce((n, g) => n + g.items.length, 0)} 项命令、技能与自动化`, "系统"),
			...d.capGroups.map((group) => section(doc, `${group.label} · ${group.items.length}`, [
				el(doc, "div", { class: "ta-project-grid" }, ...group.items.map((item) => {
					const card = el(doc, "button", { type: "button", class: "ta-project-card" },
						el(doc, "div", { class: "ta-card-title" }, el(doc, "h3", {}, item.name)),
						el(doc, "p", {}, item.desc || "未提供说明"),
						el(doc, "footer", {}, el(doc, "span", {}, item.invoke), el(doc, "span", {}, group.meta)));
					if (item.path) card.addEventListener("click", () => ctx.openDrawer(item.path!));
					return card;
				})),
			]))];
	}
	if (ctx.tab === "vault") {
		return [summary,
			heading(doc, "全库", `共 ${num(d.total)} 篇笔记`, "系统"),
			panel(doc, "内容目录", distribution(ctx, d.dist.map((x) => ({ name: x.name, count: x.count, onClick: () => ctx.openDrawer(x.readme) })), "知识笔记共 {total} 篇")),
			panel(doc, "全部模块", distribution(ctx, d.modules.map((m) => ({ name: m.name, count: m.count, onClick: () => ctx.openDrawer(m.readme) })), "含系统与配置共 {total} 篇"))];
	}
	return [summary,
		heading(doc, "系统健康", "健康分、错误模式与闭环状态", "系统"),
		metricStrip(ctx, d.healthDigest.metrics),
		signalDeck(ctx, "errors", "错误模式", d.healthDigest.errors, "错误"),
		signalDeck(ctx, "loops", "闭环状态", d.healthDigest.loopStatus, "闭环")];
}

export function renderPreferences(ctx: LensContext): LensChild[] {
	const { doc } = ctx;
	const host = el(doc, "div", { class: "talos-lens-native talos-lens-settings" });
	ctx.renderSettings(host);
	return [heading(doc, "设置", "界面语言、外观、库与数据、对话模型与语音"), host];
}
