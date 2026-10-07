import { describe, expect, it, vi } from "vitest";
import { flowStations, renderFlowPipeline } from "../src/ui/flow-pipeline";
import type { Collected } from "../src/ui/talos-view-model";
import type { TalosView } from "../src/view";
import { createObsidianHost } from "./helpers/obsidian-dom";

function collected(overrides: { inboxCount?: number; oldestDays?: number; queue?: number; platforms?: Collected["output"]["platforms"] } = {}): Collected {
	return {
		inbox: { count: overrides.inboxCount ?? 32, oldestDays: overrides.oldestDays ?? 52, clusters: [], recent: [], ageBuckets: [] },
		knowledge: {
			metrics: [
				{ label: "MOC 枢纽", value: "12", sub: "" },
				{ label: "原创洞察", value: "132", sub: "" },
				{ label: "外部素材", value: "346", sub: "" },
			],
			mocs: [],
			recentInsights: [],
			recentMaterials: [],
		},
		output: {
			metrics: [{ label: "今日待发", value: String(overrides.queue ?? 2), sub: "" }],
			queue: [],
			opsCandidates: [],
			platforms: overrides.platforms ?? [
				{ name: "抖音", count: 5, published: 3, pending: 1, readme: "a.md", latestTitle: "" },
				{ name: "公众号", count: 2, published: 2, pending: 0, readme: "b.md", latestTitle: "" },
			],
		},
	} as unknown as Collected;
}

describe("content flow pipeline", () => {
	it("reads every station from existing statistics", () => {
		const stations = flowStations(collected());
		expect(stations.map((s) => [s.label, s.value])).toEqual([
			["收件", "32"],
			["洞察", "132"],
			["素材", "346"],
			["待发", "2"],
			["已发", "5/7"],
		]);
		expect(stations.map((s) => s.pageKey)).toEqual(["inbox", "knowledge", "knowledge", "output", "output"]);
	});

	it("flags stuck stations: two-week backlog, queued posts and unclosed drafts", () => {
		const stuck = (d: Collected) => flowStations(d).filter((s) => s.stuck).map((s) => s.key);
		expect(stuck(collected())).toEqual(["inbox", "queue", "published"]);
		expect(stuck(collected({ oldestDays: 13, queue: 0, platforms: [{ name: "抖音", count: 3, published: 3, pending: 0, readme: "", latestTitle: "" }] }))).toEqual([]);
		expect(flowStations(collected({ inboxCount: 0 }))[0]).toMatchObject({ sub: "已清空", stuck: false });
	});

	it("highlights the current page and navigates from the other stations", () => {
		const navigateToPage = vi.fn();
		const view = { navigateToPage } as unknown as TalosView;
		const { host, element } = createObsidianHost();
		renderFlowPipeline(view, host, collected(), "knowledge");
		const stations = element.all("talos-flow-station");
		expect(stations.filter((s) => s.classList.contains("is-current")).map((s) => s.dataset.flowStation)).toEqual(["insights", "materials"]);
		stations[0].click();
		stations[1].click();
		stations[4].click();
		expect(navigateToPage.mock.calls).toEqual([["inbox"], ["output"]]);
	});
});
