import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { functionSource, viewSource as readViewSource, expectSourceContains } from "./helpers/source-text";

const root = fileURLToPath(new URL("../", import.meta.url));
const view = readViewSource();
const css = readFileSync(`${root}styles.ui-v2.css`, "utf8");
const page = functionSource(view, "renderTalosPage");

describe("TALOS release governance v2", () => {
	it("uses an equal release-data and critical-gates first screen", () => {
		expect(page).toContain(
			'cls: "workflow-v2-primary talos-v2-primary"'
		);
		expect(page).toContain('"data-workflow-section", "core-data"');
		expect(page).toContain('"attention-and-actions"');
		expect(page).not.toContain("dashboard-grid");
		expect(page).not.toContain("fillMetricGrid");
	});

	it("charts real gate states without invented denominators", () => {
		expect(view).toContain("private fillGateStateChart(");
		expect(view).toContain(
			"gates.filter((gate) => gate.state === state.key).length"
		);
		expect(view).toContain("(item.count / gates.length) * 100");
		for (const state of ["done", "ready", "blocked", "todo"]) {
			expect(view).toContain(`key: "${state}"`);
			expectSourceContains("styles.ui-v2.css", `.state-${state}`);
		}
	});

	it("preserves the release banner, existing gates, and product module cards", () => {
		expect(page).toContain("fillBanner(view, banner, d.warRoom)");
		expect(page).toContain("fillGates(view, ");
		expect(page).toContain("fillTalosModules(view, ");
		expect(page).toContain("talos-v2-module-panel");
		expectSourceContains("styles.ui-v2.css", ".talos-v2-module-panel .module-grid");
	});

	it("reflows gates and modules while respecting reduced motion", () => {
		expectSourceContains("styles.ui-v2.css", "@container workflow-v2 (max-width: 760px)");
		expectSourceContains("styles.ui-v2.css", "@container workflow-v2 (max-width: 520px)");
		expect(css).toMatch(
			/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.talos-v2-gate-chart__segment\s*\{[^}]*transition:\s*none/
		);
	});
});
