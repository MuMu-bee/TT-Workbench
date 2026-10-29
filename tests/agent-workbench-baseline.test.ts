import { describe, expect, it } from "vitest";
import { pluginSource as readPluginSource, viewSource as readViewSource, expectSourceContains, expectSourceNotContains } from "./helpers/source-text";

const main = readPluginSource();
const view = readViewSource();

describe("D-TLP-034 ownership baseline", () => {
	it("makes the TALOS plugin own the workbench by composition", () => {
		expect(main).toMatch(/class TalosPlugin extends Plugin\b/);
		expect(main).not.toContain("extends ClaudianWorkbenchPlugin");
		expect(main).not.toContain("await super.onload()");
	});

	// 2026-10-08：TALOS 智能体改为常驻右侧边栏，主区助手组只保留 Harness 页。
	it("hosts TALOS Agent in the right sidebar view and keeps Harness in the console", () => {
		expect(main).toContain("new TalosAgentWorkbench({ leaf: this.leaf, service, customApi: this.host.customApi })");
		expect(view).not.toContain("TalosAgentWorkbench");
		expect(view).toContain("new HarnessWorkbench({");
	});

	it("never rewrites legacy Claudian sessions during startup", () => {
		expectSourceContains("src/agent-workbench/legacy/claudian-readonly-importer.ts", "sourceAggregateBefore");
		expectSourceContains("src/agent-workbench/legacy/claudian-readonly-importer.ts", "sourceAggregateAfter");
		expectSourceNotContains("src/agent-workbench/legacy/claudian-readonly-importer.ts", "legacy.write");
	});
});
