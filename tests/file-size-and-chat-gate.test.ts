import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
	FILE_TARGET_LINES,
	FUNCTION_TARGET_LINES,
	GATED_FILES,
	GATED_FUNCTIONS,
	checkFileSizes,
	checkTargets,
	countFileLines,
	measureFunction,
	measureFunctionSizes,
	loadBaseline,
} from "../scripts/check-file-size.mjs";
import { CASES, runAll } from "../scripts/run-chat-gate-fixtures.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Q-ARC12：体量门 + 拆分进度基线。
 *
 * 方案要求「先落可度量门」再谈拆分。这里断言三件事：
 *  ① 门槛本身可判定（棘轮模式当前 0 违规；目标模式当前必红，说明 800/100 尚未达成）；
 *  ② 基线里的每个数字与实测一致（防止有人改基线「假装」下降）；
 *  ③ 度量口径对四个被点名的函数都拿得到真实区间（不靠字符串巧合）。
 */
describe("file size gate (Q-ARC12)", () => {
	it("keeps the ratchet clean and records the not-yet-reached 800/100 targets", () => {
		const ratchet = checkFileSizes(repoRoot);
		expect(ratchet.violations).toEqual([]);
		// 拆分未完成：目标模式必须报出剩余的 5 项超限
		// （2 个文件 + 3 个函数）。`handleServerEvent()` 已在 F2 事件表化后降到 5 行，
		// 不再出现在这份清单里 —— 这条断言把「还差哪几项」写成可判定事实。
		const targets = checkTargets(repoRoot);
		expect(targets.violations.map((violation) => violation.rule).sort()).toEqual([
			"file-size-target",
			"file-size-target",
			"function-size-target",
			"function-size-target",
			"function-size-target",
		]);
		// 已经达标的那个函数必须不在超限清单里。
		expect(targets.violations.map((violation) => violation.target)).not.toContain(
			"src/quyuan/qwen-realtime-voice.ts#handleServerEvent()"
		);
		expect(FILE_TARGET_LINES).toBe(800);
		expect(FUNCTION_TARGET_LINES).toBe(100);
	});

	it("pins every baseline number to the current measurement so it can only go down", () => {
		const baseline = loadBaseline(repoRoot);
		for (const file of checkFileSizes(repoRoot).files) {
			expect(baseline.files[file.file]).toBe(file.lines);
		}
		for (const fn of measureFunctionSizes(repoRoot)) {
			expect(baseline.functions[`${fn.file}#${fn.name}`]).toBe(fn.lines);
		}
		expect(Object.keys(baseline.files).sort()).toEqual([...GATED_FILES].sort());
		expect(Object.keys(baseline.functions).sort()).toEqual(
			GATED_FUNCTIONS.map((target) => `${target.file}#${target.name}`).sort()
		);
	});

	it("measures all four gated functions by brace balance, not by string coincidence", () => {
		for (const target of GATED_FUNCTIONS) {
			const measured = measureFunctionSizes(repoRoot).find(
				(candidate) => candidate.file === target.file && candidate.name === target.name
			);
			expect(measured?.found).toBe(true);
			// 起始行与方案实测一致（行号漂移时这条先红，避免门悄悄量到别的函数）。
			expect(measured?.startLine).toBe(target.startLine);
			expect(measured?.endLine).toBeGreaterThan(target.startLine);
			expect(measured?.lines).toBe((measured?.endLine ?? 0) - target.startLine + 1);
		}
	});

	it("counts file lines the same way on LF and CRLF inputs and tolerates a missing trailing newline", () => {
		expect(countFileLines("a\nb\nc\n")).toBe(3);
		expect(countFileLines("a\r\nb\r\nc\r\n")).toBe(3);
		expect(countFileLines("a\nb\nc")).toBe(3);
		// 参数表里的 `= {}` 不能把函数体提前截断。
		const source = [
			"\tasync *execute(",
			"\t\trequest: Request,",
			"\t\tinteractions: Interactions = {},",
			"\t): AsyncGenerator<Event> {",
			"\t\tif (request) {",
			"\t\t\treturn;",
			"\t\t}",
			"\t}",
		].join("\n");
		expect(measureFunction(source, "\tasync *execute(")).toEqual({ startLine: 1, endLine: 8, lines: 8 });
	});
});

/**
 * Q-TES9：chat-gate 的合成夹具跑法。
 *
 * 这条把「唯一的功能硬门」从手工项变成每次提交都会执行的可判定断言：
 * 正例夹具必须 exit 0、反例（缺 turn.finished）必须 exit 1。
 */
describe("chat gate synthetic fixtures (Q-TES9)", () => {
	it("passes the complete-turn fixture and fails the missing-finish fixture", () => {
		const { results, failed } = runAll(repoRoot);
		expect(failed).toEqual([]);
		expect(results.map((result) => [result.name, result.exitCode])).toEqual(
			CASES.map((testCase) => [testCase.name, testCase.expectedExitCode])
		);
		// 正例输出里必须出现「完整有序回合：1」；反例必须给出缺回合的失败原因，
		// 否则「通过」可能只是夹具路径不存在导致的假绿。
		const pass = results.find((result) => result.name === "pass");
		expect(pass?.output.includes("完整有序回合：1"), "正例未输出完整有序回合计数").toBe(true);
		const fail = results.find((result) => result.name === "fail-no-finish");
		expect(
			fail?.output.includes("窗口内没有完整的 user.message -> assistant.final -> turn.finished 回合"),
			"反例未给出缺回合的失败原因"
		).toBe(true);
	});
});
