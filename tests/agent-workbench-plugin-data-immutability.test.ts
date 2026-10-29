import { describe, expect, it } from "vitest";
import { pluginSource as readPluginSource, viewSource as readViewSource, expectSourceContains } from "./helpers/source-text";

const mainSource = readPluginSource();
const viewSource = readViewSource();

describe("agent workbench plugin data immutability", () => {
	it("stores TALOS-owned settings, permissions and bindings only in the sidecar namespace", () => {
		expect(mainSource).toContain('const workbenchStateRoot = ".talos/agent-workbench/v1"');
		expect(mainSource).toContain('`${workbenchStateRoot}/settings.json`');
		expect(mainSource).toContain('`${workbenchStateRoot}/permission-rules.json`');
		expect(mainSource).toContain('`${workbenchStateRoot}/runtime-bindings.json`');
		expect(mainSource).toContain('`${workbenchStateRoot}/input-ledger.json`');
		expect(mainSource).toContain('`${workbenchStateRoot}/ui-state.json`');
		expect(mainSource).not.toContain("stored.agentWorkbenchPermissionRules");
		expect(mainSource).not.toContain("stored.agentWorkbenchBindings");
		expect(mainSource).toContain("chat-surface.json");
		// 双通道切换已拆分（对话进右栏、Harness 独立页），控制台不再写通道选择。
		expect(viewSource).not.toContain("setAgentWorkbenchSurface");
		expect(viewSource).not.toContain("this.plugin.talosSettings.harnessSurface = id");
		expect(viewSource).not.toContain("view.plugin.talosSettings.harnessSurface = id");
	});

	it("uses atomic TALOS sidecar writes and keeps old source bytes read-only", () => {
		expectSourceContains("src/agent-workbench/storage/obsidian-workbench-storage.ts", "writeJsonAtomic");
		expectSourceContains("src/agent-workbench/storage/obsidian-workbench-storage.ts", "await this.flush()");
		expectSourceContains("src/agent-workbench/storage/obsidian-workbench-storage.ts", "await this.replace(temporary, file)");
		expectSourceContains("src/agent-workbench/legacy/claudian-readonly-importer.ts", "sourceAggregateBefore");
		expectSourceContains("src/agent-workbench/legacy/claudian-readonly-importer.ts", "sourceAggregateAfter");
		expectSourceContains("src/agent-workbench/legacy/claudian-readonly-importer.ts", "旧 Claudian 源数据在导入期间发生变化");
	});
});
