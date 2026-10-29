import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkBoundaries,
	checkQuyuanOrphanContracts,
	loadBaseline,
	loadQuyuanOrphanBaseline,
	partition,
} from "../scripts/check-module-boundaries.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

describe("module boundaries", () => {
	it("catches the adapters/legacy -> ai/provider edges ROADMAP:34 names", () => {
		const { violations } = checkBoundaries(repoRoot);
		const mainRule = violations.filter(
			(violation) => violation.rule === "adapters-legacy-to-ai-provider"
		);
		expect(mainRule).toHaveLength(6);
		expect(mainRule.map((violation) => violation.file)).toEqual([
			"src/agent-workbench/adapters/api/direct-api-runtime-adapter.ts",
			"src/agent-workbench/adapters/api/direct-api-runtime-adapter.ts",
			"src/agent-workbench/adapters/api/direct-api-runtime-adapter.ts",
			"src/agent-workbench/legacy/legacy-codex-credential-migrator.ts",
			"src/agent-workbench/legacy/legacy-codex-credential-migrator.ts",
			"src/agent-workbench/legacy/legacy-codex-credential-migrator.ts",
		]);
		expect(mainRule.map((violation) => violation.line)).toEqual([8, 9, 10, 2, 3, 4]);
	});

	it("keeps the two zero-baseline guardrails clean and blocks a new upward import", () => {
		const { violations } = checkBoundaries(repoRoot);
		// 护栏当前基线 0：纯防回退，任何命中都说明分层被破坏。
		expect(violations.filter((violation) => violation.rule !== "adapters-legacy-to-ai-provider"))
			.toEqual([]);
	});

	it("passes when every violation is tracked in the baseline", () => {
		const { violations } = checkBoundaries(repoRoot);
		const allowed = loadBaseline(repoRoot);
		const { blocking, stale } = partition(violations, allowed);
		expect(blocking).toEqual([]);
		// 白名单不得留下没人命中的条目，否则存量违规会悄悄「合法化」。
		expect(stale).toEqual([]);
	});

	it("reports violations with file and line for a freshly injected edge", () => {
		const scratch = mkdtempSync(join(tmpdir(), "talos-boundaries-"));
		try {
			for (const directory of [
				"src/agent-workbench/core",
				"src/agent-workbench/ui",
				"src/agent-workbench/contracts",
				"src/agent-workbench/adapters/api",
				"src/ai/provider",
			]) {
				mkdirSync(join(scratch, directory), { recursive: true });
			}
			writeFileSync(
				join(scratch, "src/agent-workbench/core/probe.ts"),
				'import type { X } from "../ui/talos-agent-workbench";\n'
			);
			writeFileSync(
				join(scratch, "src/agent-workbench/core/host-import.ts"),
				'import { Notice } from "obsidian";\n'
			);
			writeFileSync(
				join(scratch, "src/agent-workbench/contracts/parent.ts"),
				'import type { Y } from "../core/probe";\n'
			);
			writeFileSync(
				join(scratch, "src/agent-workbench/adapters/api/leak.ts"),
				'import { AnthropicApiProvider } from "../../../ai/provider/anthropic-api-provider";\n'
			);
			const { violations } = checkBoundaries(scratch);
			expect(violations).toEqual([
				{
					file: "src/agent-workbench/adapters/api/leak.ts",
					line: 1,
					text: 'import { AnthropicApiProvider } from "../../../ai/provider/anthropic-api-provider";',
					rule: "adapters-legacy-to-ai-provider",
					specifier: "../../../ai/provider/anthropic-api-provider",
				},
				{
					file: "src/agent-workbench/contracts/parent.ts",
					line: 1,
					text: 'import type { Y } from "../core/probe";',
					rule: "contracts-no-parent-import",
					specifier: "../core/probe",
				},
				{
					file: "src/agent-workbench/core/host-import.ts",
					line: 1,
					text: 'import { Notice } from "obsidian";',
					rule: "layer-no-upward-import",
					specifier: "obsidian",
				},
				{
					file: "src/agent-workbench/core/probe.ts",
					line: 1,
					text: 'import type { X } from "../ui/talos-agent-workbench";',
					rule: "layer-no-upward-import",
					specifier: "../ui/talos-agent-workbench",
				},
			]);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("refuses a baseline entry that carries no tracking information", () => {
		const scratch = mkdtempSync(join(tmpdir(), "talos-baseline-"));
		try {
			mkdirSync(join(scratch, "scripts"), { recursive: true });
			writeFileSync(
				join(scratch, "scripts/module-boundaries-baseline.json"),
				JSON.stringify({
					allowed: [
						{
							file: "src/agent-workbench/adapters/api/direct-api-runtime-adapter.ts",
							rule: "adapters-legacy-to-ai-provider",
							specifier: "../../../ai/provider/anthropic-api-provider",
						},
					],
				})
			);
			expect(() => loadBaseline(scratch)).toThrow(/issue 或 reviewBy/);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("is wired into the build chain and CI", () => {
		const packageJson = JSON.parse(
			readFileSync(join(repoRoot, "package.json"), "utf8")
		) as { scripts: Record<string, string> };
		expect(packageJson.scripts["check:boundaries"]).toBe("node scripts/check-module-boundaries.mjs");
		expect(packageJson.scripts.build).toContain("check-module-boundaries.mjs");
		const ci = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
		expect(ci).toContain("npm run check:boundaries");
	});
});

describe("quyuan contract islands (Q-ARC6)", () => {
	it("keeps the deleted capability-contract island from coming back", () => {
		// 删除路径的验收：这组文件不再存在，且全仓没有任何引用。
		for (const file of [
			"src/quyuan/contract.ts",
			"src/quyuan/workbench-adapter.ts",
			"src/quyuan/module.ts",
			"src/quyuan/index.ts",
		]) {
			expect(() => readFileSync(join(repoRoot, file), "utf8")).toThrow();
		}
		const { violations } = checkQuyuanOrphanContracts(repoRoot);
		const files = violations.map((violation) => violation.file);
		expect(files).not.toContain("src/quyuan/contract.ts");
		// 存量孤岛必须与白名单完全一致，不能多也不能少。
		const allowed = loadQuyuanOrphanBaseline(repoRoot).map(
			(entry: { file: string }) => entry.file
		);
		expect(files.sort()).toEqual([...allowed].sort());
	});

	it("flags a newly injected orphan contract and clears a wired one", () => {
		const scratch = mkdtempSync(join(tmpdir(), "talos-quyuan-orphan-"));
		try {
			mkdirSync(join(scratch, "src/quyuan"), { recursive: true });
			mkdirSync(join(scratch, "tests"), { recursive: true });
			// 孤岛：导出 interface、无 implements、src/ 内无导入，只被 tests/ 引用。
			writeFileSync(
				join(scratch, "src/quyuan/orphan.ts"),
				"export interface OrphanAdapter {\n\tstart(): void;\n}\n"
			);
			writeFileSync(
				join(scratch, "tests/orphan.test.ts"),
				'import type { OrphanAdapter } from "../src/quyuan/orphan";\n'
			);
			expect(checkQuyuanOrphanContracts(scratch).violations.map((v) => v.file))
				.toEqual(["src/quyuan/orphan.ts"]);

			// 接上真实实现后不再算孤岛。
			writeFileSync(
				join(scratch, "src/quyuan/orphan-impl.ts"),
				'import type { OrphanAdapter } from "./orphan";\n'
				+ "export class RealAdapter implements OrphanAdapter { start(): void {} }\n"
			);
			expect(checkQuyuanOrphanContracts(scratch).violations).toEqual([]);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("does not flag an interface file the product code actually imports", () => {
		const scratch = mkdtempSync(join(tmpdir(), "talos-quyuan-wired-"));
		try {
			mkdirSync(join(scratch, "src/quyuan"), { recursive: true });
			mkdirSync(join(scratch, "tests"), { recursive: true });
			writeFileSync(
				join(scratch, "src/quyuan/ports.ts"),
				"export interface HostPort {\n\trust(): void;\n}\n"
			);
			writeFileSync(
				join(scratch, "src/quyuan/consumer.ts"),
				'import type { HostPort } from "./ports";\nexport type Use = HostPort;\n'
			);
			expect(checkQuyuanOrphanContracts(scratch).violations).toEqual([]);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
