import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pluginSource as readPluginSource, viewSource as readViewSource } from "./helpers/source-text";

const root = fileURLToPath(new URL("../", import.meta.url));
const main = readPluginSource();
const view = readViewSource();
const importer = readFileSync(`${root}src/agent-workbench/legacy/claudian-readonly-importer.ts`, "utf8");

describe("D-TLP-034 ownership baseline", () => {
	it("makes the TALOS plugin own the workbench by composition", () => {
		expect(main).toMatch(/class TalosPlugin extends Plugin\b/);
		expect(main).not.toContain("extends ClaudianWorkbenchPlugin");
		expect(main).not.toContain("await super.onload()");
	});

	// 2026-10-08：TALOS 智能体改为常驻右侧边栏，主区助手组只保留 Harness 页。
	it("hosts TALOS Agent in the right sidebar view and keeps Harness in the console", () => {
		expect(main).toContain("new TalosAgentWorkbench({ leaf: this.leaf, service })");
		expect(view).not.toContain("TalosAgentWorkbench");
		expect(view).toContain("new HarnessWorkbench({");
	});

	it("never rewrites legacy Claudian sessions during startup", () => {
		expect(importer).toContain("sourceAggregateBefore");
		expect(importer).toContain("sourceAggregateAfter");
		expect(importer).not.toContain("legacy.write");
	});
});
