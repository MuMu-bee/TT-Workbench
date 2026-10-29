import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// Q-QUA18：图表函数原来是源码文本断言（`const classified = ...` / `const total = Math.max(...)`），
// 这两行被删掉后就只能靠改断言维持绿色。改成行为断言：直接渲染并检查三个桶的宽度与读数。
// 图表模块值导入 obsidian（page-primitives 的 setIcon）与 actions（openFile），两者都要 mock。
vi.mock("obsidian", () => ({ setIcon: vi.fn() }));
vi.mock("../src/actions", () => ({ openFile: vi.fn() }));

import { functionSource, viewSource as readViewSource, expectSourceContains } from "./helpers/source-text";
import { createObsidianHost, type ObsidianTestElement } from "./helpers/obsidian-dom";
import { fillOutputClosureChart } from "../src/ui/charts/talos-view-charts";
import type { OutputPlatform } from "../src/types";
import type { TalosView } from "../src/view";

const root = fileURLToPath(new URL("../", import.meta.url));
const view = readViewSource();
const css = readFileSync(`${root}styles.ui-v2.css`, "utf8");
const outputPage = functionSource(view, "renderOutputPage");

describe("Output workflow v2", () => {
	it("splits real closure data and today's attention equally", () => {
		expect(outputPage).toContain(
			'cls: "workflow-v2-primary output-v2-primary"'
		);
		expect(outputPage).toContain('"data-workflow-section", "core-data"');
		expect(outputPage).toContain('"attention-and-actions"');
		expect(outputPage).not.toContain("dashboard-grid");
		expect(outputPage).not.toContain("fillMetricGrid");
	});

	it("builds stacked bars only from platform source counts", () => {
		expect(view).toContain("private fillOutputClosureChart(");
		// 直接渲染：三段的宽度之和必须正好是 100%，且「未分类」段来自 platform.unclassified
		// 这个独立计数，而不是 count 与 classified 的残差。
		const platform: OutputPlatform = {
			name: "抖音",
			count: 6,
			published: 3,
			pending: 2,
			unclassified: 1,
			readme: "输出/抖音/_README.md",
			latestTitle: "—",
		};
		const { host, element } = createObsidianHost();
		fillOutputClosureChart({ app: {} } as unknown as TalosView, host, [platform]);
		const track = element.one("output-v2-bar-track");
		const widths = track.children.map((segment) => (segment as ObsidianTestElement).style.width);
		expect(widths).toEqual(["50%", "33.33333333333333%", "16.666666666666664%"]);
		expect(track.getAttribute("aria-label")).toBe("抖音：已发布 3，待闭环 2，未分类 1");
		expect((track.children[2] as ObsidianTestElement).className).toBe("output-v2-bar-segment tone-unclassified");
		for (const tone of ["published", "pending", "unclassified"]) {
			expectSourceContains("styles.ui-v2.css", `.tone-${tone}`);
		}
	});

	it("keeps queue and candidates, and folds platform cards into the closure chart", () => {
		expect(outputPage).toContain('"今日待发"');
		expect(outputPage).toContain('"运营候选"');
		expect(outputPage).toContain("fillSignalList(");
		expect(outputPage).toContain('mountFlowPipeline(view, hero, d, "output")');
		expect(outputPage).toContain("stats: []");
		expect(outputPage).not.toContain("fillPlatforms(");
		expect(outputPage).not.toContain("output-v2-platform-panel");
	});

	it("reflows platform details and respects reduced motion", () => {
		expectSourceContains("styles.ui-v2.css", "@container workflow-v2 (max-width: 760px)");
		expectSourceContains("styles.ui-v2.css", "@container workflow-v2 (max-width: 480px)");
		expect(css).toMatch(
			/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.output-v2-bar-segment\s*\{[^}]*transition:\s*none/
		);
	});
});
