import { describe, expect, it } from "vitest";
import { formatRuntimeErrorLines } from "../src/plugin/quyuan-diagnostics-format";
import type { QuyuanRuntimeErrorRecord } from "../src/plugin/plugin-support";

// 刻意不 mock obsidian：新模块零 obsidian 依赖，直接 import 即可。
const fixtures: QuyuanRuntimeErrorRecord[] = [
	{
		at: "2026-07-14T08:00:00.000Z",
		scope: "activateQuyuanV2View.postOpenCheck",
		message: String.raw`Failed to load C:\Users\TT\Documents\Vault\main.js`,
		stack: [
			String.raw`    at run (C:\Users\TT\AppData\main.js:10:5)`,
			"    at boot (/home/alice/app/main.js:3:1)",
		].join("\n"),
	},
	{
		at: "2026-07-14T08:05:00.000Z",
		scope: "TalosAgentRecoveryView.onOpen",
		message: "empty stack fixture",
		stack: "",
	},
];

describe("formatRuntimeErrorLines", () => {
	it("keeps the no-record placeholder for an empty list", () => {
		expect(formatRuntimeErrorLines([])).toEqual(["- 暂无记录。"]);
	});

	it("sanitizes message and stack home paths before they reach the report", () => {
		const joined = formatRuntimeErrorLines(fixtures).join("\n");

		// 本次实测值：message 一条 + stack 两条 home 路径 = 3 次
		expect(joined).not.toMatch(/Users|alice|\/home\//);
		expect(joined.match(/\[HOME_PATH\]/g)?.length).toBe(3);
	});

	it("keeps scope, timestamp and the (no stack) branch readable for triage", () => {
		const joined = formatRuntimeErrorLines(fixtures).join("\n");

		// scope 与 at 原文出现（排障要靠它们定位）
		expect(joined).toMatch(/^### 1\. activateQuyuanV2View\.postOpenCheck$/m);
		expect(joined).toMatch(/^- 时间：2026-07-14T08:00:00\.000Z$/m);
		expect(joined).toMatch(/^### 2\. TalosAgentRecoveryView\.onOpen$/m);
		expect(joined).toMatch(/^- 时间：2026-07-14T08:05:00\.000Z$/m);
		// 空 stack 记录走 (no stack)
		expect(joined).toMatch(/^\(no stack\)$/m);
	});

	it("fixes the current coverage boundary: non-home absolute paths stay verbatim", () => {
		const joined = formatRuntimeErrorLines([
			{
				at: "2026-07-14T09:00:00.000Z",
				scope: "boundary",
				message: String.raw`D:\MyVault\a.md`,
				stack: "    at boot (/opt/main.js:1:1)",
			},
		]).join("\n");

		// 固化当前边界：HOME_PATH 只认 /Users、/home 与 X:\Users，
		// 这些非 home 绝对路径仍原样保留——不要据此以为已全覆盖。
		expect(joined).toMatch(/^- 错误：D:\\MyVault\\a\.md$/m);
		expect(joined).toMatch(/^ {4}at boot \(\/opt\/main\.js:1:1\)$/m);
	});
});
