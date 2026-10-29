// 「内容流」流水线：收件 → 洞察 → 素材 → 待发 → 已发。
// 2026-10-07 导航重构第二期：收件箱、知识库、输出三页共用这条流水线代替各自的页头指标，
// 数字只取既有统计（inbox / knowledge.metrics / output），不重新扫描 Vault。
import type { Collected } from "./talos-view-model";
import type { TalosView } from "../view";

export type FlowStationKey = "inbox" | "insights" | "materials" | "queue" | "published";

export interface FlowStation {
	key: FlowStationKey;
	label: string;
	value: string;
	sub: string;
	pageKey: "inbox" | "knowledge" | "output";
	stuck: boolean;
}

const STUCK_INBOX_DAYS = 14;

function metricValue(metrics: Collected["knowledge"]["metrics"], label: string): string {
	return metrics.find((metric) => metric.label === label)?.value ?? "0";
}

/** 五个站点及其卡点；卡点 = 收件积压超过两周、有待发条目、或有平台稿件未闭环。 */
export function flowStations(d: Collected): FlowStation[] {
	const queue = Number(metricValue(d.output.metrics, "今日待发")) || 0;
	const total = d.output.platforms.reduce((sum, platform) => sum + Math.max(platform.count, platform.published + platform.pending), 0);
	const published = d.output.platforms.reduce((sum, platform) => sum + platform.published, 0);
	// Q-QUA18：待闭环只数 pending 桶，不再用「总数减已发布」的残差——那会把未分类
	// 也算成待闭环，让指标显示「6 待闭环」而同一页面图显示「3 待闭环 + 3 未分类」。
	const totalPending = d.output.platforms.reduce((sum, platform) => sum + platform.pending, 0);
	return [
		{
			key: "inbox",
			label: "收件",
			value: String(d.inbox.count),
			sub: d.inbox.count > 0 ? `最老 ${d.inbox.oldestDays} 天` : "已清空",
			pageKey: "inbox",
			stuck: d.inbox.count > 0 && d.inbox.oldestDays >= STUCK_INBOX_DAYS,
		},
		{
			key: "insights",
			label: "洞察",
			value: metricValue(d.knowledge.metrics, "原创洞察"),
			sub: "原创",
			pageKey: "knowledge",
			stuck: false,
		},
		{
			key: "materials",
			label: "素材",
			value: metricValue(d.knowledge.metrics, "外部素材"),
			sub: "外部",
			pageKey: "knowledge",
			stuck: false,
		},
		{
			key: "queue",
			label: "待发",
			value: String(queue),
			sub: queue > 0 ? "统一出口待处理" : "出口已清空",
			pageKey: "output",
			stuck: queue > 0,
		},
		{
			key: "published",
			label: "已发",
			value: `${published}/${total}`,
			// 条件也换成 totalPending：只改插值的话，只有未分类笔记时这里会显示「0 待闭环」
			// 而不是「全部闭环」，与同一页面的图（未分类单列一段）仍然自相矛盾。
			sub: totalPending > 0 ? `${totalPending} 待闭环` : "全部闭环",
			pageKey: "output",
			stuck: total > published,
		},
	];
}

export function renderFlowPipeline(view: TalosView, parent: HTMLElement, d: Collected, activePage: string): HTMLElement {
	const pipeline = parent.createDiv({ cls: "talos-flow-pipeline" });
	pipeline.setAttribute("role", "list");
	pipeline.setAttribute("aria-label", "内容流水线");
	for (const station of flowStations(d)) {
		const current = station.pageKey === activePage;
		const item = pipeline.createDiv({
			cls: `talos-flow-station${current ? " is-current" : ""}${station.stuck ? " is-stuck" : ""}`,
		});
		item.setAttribute("role", "listitem");
		item.dataset.flowStation = station.key;
		item.createEl("small", { text: station.label });
		item.createEl("b", { text: station.value });
		item.createEl("span", { text: station.sub });
		if (!current) {
			item.setAttribute("tabindex", "0");
			item.setAttribute("aria-label", `打开${station.label}：${station.value}`);
			const open = () => view.navigateToPage(station.pageKey);
			item.addEventListener("click", open);
			item.addEventListener("keydown", (event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				open();
			});
		}
	}
	return pipeline;
}

/** 把流水线放进页头原指标位置；页头不再重复展示同一组数字。 */
export function mountFlowPipeline(view: TalosView, hero: HTMLElement, d: Collected, activePage: string): void {
	const slot = hero.querySelector<HTMLElement>(".talos-ui-page-header__metrics") ?? hero;
	slot.addClass("has-flow-pipeline");
	renderFlowPipeline(view, slot, d, activePage);
}
