import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutImports } from "./helpers/source-text";

/**
 * Q-SEC10：转写区文案与真实出库流向一致。
 *
 * 事实链（读码确认）：`native-voice-driver.ts` 每轮把历史作为 `historyText` 送去出库审计
 * 并把 history 交给 runtime，而 UI 原文案写「仅显示转写 · 不自动注入 AI 对话」。
 * 报告已声明这不是漏洞（该路径经 `inspectVaultContent` 过闸），所以本条只改文案，
 * 不改审计或 history 传递逻辑。
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string): string => readFileSync(`${root}${path}`, "utf8");

const panel = read("src/quyuan/voice-panel.ts");
const panelImpl = withoutImports(panel);
const driver = read("src/quyuan/native-voice-driver.ts");

describe("voice panel transcript copy matches the real egress flow (Q-SEC10)", () => {
	it("locks the new transcript-head literal exactly once", () => {
		const literal = "实时转写 · 语音历史随只读查询出库审计";
		expect(panelImpl.includes(literal)).toBe(true);
		// 精确字面量恰好出现 1 次（不是靠「含转写」这种会被文件里 7 处「转写」满足的弱断言）。
		const occurrences = panelImpl.split(literal).length - 1;
		expect(occurrences).toBe(1);
		// 误导性旧文案在源码内已归零。
		expect(panelImpl.includes("不自动注入 AI 对话")).toBe(false);
	});

	it("appends the audit disclosure at the end of the existing safety line", () => {
		// 既有连续子串必须完整（tests/voice-readonly-policy.test.ts 用它锁定）。
		expect(panelImpl.includes("语音工具只读；仅明确说“联网搜索”或“上网查”才发送当前问题")).toBe(true);
		// 新披露追加在句末，而不是句中插入（句中插入会破坏上面那条连续子串）。
		expect(
			panelImpl.includes("才发送当前问题 · 语音历史参与每轮出库审计")
		).toBe(true);
	});

	it("keeps the copy and the driver's history egress from diverging", () => {
		// 交叉断言：driver 仍把历史作为 historyText 出库时，面板必须含「出库审计」字样；
		// 任一变化另一侧就失败，防止文案与代码再次分叉。
		const driverSendsHistory = driver.includes("historyText: JSON.stringify(this.history)");
		expect(driverSendsHistory).toBe(true);
		if (driverSendsHistory) {
			expect(panelImpl.includes("出库审计")).toBe(true);
		}
	});
});
