import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pluginSource as readPluginSource, expectSourceContains, expectSourceNotContains } from "./helpers/source-text";

// `new URL("../").pathname` 在 win32 上产出 `/C:/...`，拼接会得到 `C:\C:\...`；
// 统一走 fileURLToPath 取真实绝对路径。
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const inputController = readFileSync(
	`${projectRoot}src/agent-workbench/core/agent-execution-coordinator.ts`,
	"utf8"
);
const mainSource = readPluginSource();

describe("chat egress wiring", () => {
	it("audits normal and steered messages before they reach the Provider", () => {
		const queryAudit = inputController.indexOf("await this.options.preflightEgress?.({");
		const querySend = inputController.indexOf(
			"for await (const nativeEvent of lease.runtime.send(turn))"
		);
		const contextSent = inputController.indexOf(
			"await this.options.ledger.stage(staged);"
		);
		const steerAudit = inputController.lastIndexOf(
			"await this.options.preflightEgress?.({"
		);
		const steerSend = inputController.indexOf(
			"await runtime.steer({ turnId: active.turnId, text });"
		);

		expect(queryAudit).toBeGreaterThan(-1);
		expect(contextSent).toBeGreaterThan(queryAudit);
		expect(querySend).toBeGreaterThan(queryAudit);
		expect(steerAudit).toBeGreaterThan(queryAudit);
		expect(steerSend).toBeGreaterThan(steerAudit);
	});

	it("fails closed when the TALOS egress audit bridge is missing", () => {
		// D-WP7 安全合同：审计桥缺失必须抛错阻断，不得静默放行。
		expectSourceNotContains("src/agent-workbench/core/agent-execution-coordinator.ts", 
			"if (!bridge.auditQuyuanChatEgress) return;"
		);
		const guard = inputController.indexOf("if (preflight && !preflight.allowed)");
		const thrower = inputController.indexOf("Provider 出库隐私审计未通过");
		expect(guard).toBeGreaterThan(-1);
		expect(thrower).toBeGreaterThan(guard);
		expectSourceContains("src/agent-workbench/core/agent-execution-coordinator.ts", "preflightEgress?");
	});

	it("persists metadata-only chat audits through the shared audit store", () => {
		expect(mainSource).toContain("preflightChatProviderEgress");
		expect(mainSource).toContain("createVaultProviderEgressAuditStore");
		expect(mainSource).toContain('namespace: "chat"');
		expect(mainSource).toContain("auditQuyuanProviderEgress");
		expect(mainSource).toContain("editorSourcePaths,");
		expect(mainSource).toContain("canvasSourcePaths,");
		expect(mainSource).toContain("hasBrowserContext:");
	});
});
