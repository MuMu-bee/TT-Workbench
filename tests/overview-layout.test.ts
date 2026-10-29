import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { functionSource, viewSource as readViewSource, expectSourceContains, expectSourceNotContains } from "./helpers/source-text";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const view = readViewSource();
const uiCss = readFileSync(`${projectRoot}styles.ui-v2.css`, "utf8");

describe("workbench dashboard and approval layout", () => {
	it("renders pending and preference decisions in one approval workspace", () => {
		expect(view).toContain("decidePreferenceCandidate");
		expect(view).toContain("overview-v2-approval-panel");
		expect(view).toContain("overview-pending-panel");
		expect(view).toContain("overview-preference-panel");
		expect(view).toContain('cls: "item approval-item candidate-approval-item"');
	});

	it("keeps the full candidate title for exact write-back", () => {
		expectSourceContains("src/data/stats.ts", 
			'out.push({ title: stripMd(s.slice(2)), meta: "待确认", path: file.path });'
		);
		expectSourceNotContains("src/data/stats.ts", "stripMd(s.slice(2)).slice(0, 70)");
	});

	it("uses a two-column now / attention / decisions first screen on the today page", () => {
		const today = functionSource(view, "renderTodayPage");
		expect(today).toContain('cls: "today-v1-grid"');
		expect(today).toContain('"data-today-section", "now"');
		expect(today).toContain('"data-today-section", "attention"');
		expect(today).toContain('"data-today-section", "decisions"');
		expect(uiCss).toMatch(
			/\.today-v1-grid \{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/
		);
	});

	it("keeps trend and distribution charts only on their home pages", () => {
		const today = functionSource(view, "renderTodayPage");
		expect(today).not.toContain("fillTrend(");
		expect(today).not.toContain("fillDist(");
		expect(functionSource(view, "renderHealthPage")).toContain("fillTrend(view, ");
		expect(functionSource(view, "renderVaultPage")).toContain("fillDist(view, ");
		expect(view).not.toContain("fillOverviewStatBar");
		expect(view).not.toContain("overview-stat-bar");
		expect(view).not.toContain("d.total / 2000");
		expect(view).not.toContain("capCount / 36");
	});

	it("keeps the task kanban and adds a recoverable quick note", () => {
		expect(view).toContain('cls: "overview-kanban"');
		expect(view).toContain('"data-today-section", "task-kanban"');
		expect(view).toContain('"任务进度"');
		expect(view).toContain("fillOverviewKanban");
		expect(view).toContain("new QuickNote({");
		expect(view).toContain('"data-workbench-section", "quick-note"');
		expectSourceContains("styles.talos.css", ".overview-kanban-col");
		expectSourceContains("styles.ui-v2.css", ".talos-quick-note");
	});

	it("removes the duplicate customer-module launcher grid", () => {
		expect(view).not.toContain("for (const module of WORKBENCH_MODULES)");
		expect(view).not.toContain("九个模块入口");
		expect(view).not.toContain("workbench-module-grid");
	});

	it("keeps decorative data-rain work within the low-end hardware budget", () => {
		expect(view).toContain("for (let i = 0; i < 8; i++)");
		expect(view).not.toContain("for (let i = 0; i < 20; i++)");
		expect(view).not.toContain('"01\\n10\\nCTX\\n01\\nSYS\\n10\\nMEM');
	});

	it("reflows by container while preserving natural page height", () => {
		expectSourceContains("styles.ui-v2.css", "container: overview-v2 / inline-size");
		expectSourceContains("styles.ui-v2.css", "@container overview-v2 (max-width: 760px)");
		expect(uiCss).not.toMatch(
			/\.talos-console\[data-talos-page="today"\] \.talos-ui-page\s*\{[^}]*min-height/s
		);
	});
});
