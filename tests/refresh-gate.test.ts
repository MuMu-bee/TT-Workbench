import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RefreshGate } from "../src/ui/refresh-gate";

const root = fileURLToPath(new URL("../", import.meta.url));

function viewSource(): string {
	return readFileSync(`${root}src/view.ts`, "utf8");
}

/**
 * 按花括号配对切出 `async refresh(): Promise<void> { … }` 的函数体。
 * 不用行号：改写后行号会漂，符号定位才稳。
 */
function refreshBody(source: string): string {
	const start = source.indexOf("async refresh(): Promise<void> {");
	expect(start, "missing refresh()").toBeGreaterThan(-1);
	const open = source.indexOf("{", start);
	expect(open).toBeGreaterThan(start);
	let depth = 0;
	let cursor = open;
	while (cursor < source.length) {
		if (source[cursor] === "{") depth += 1;
		else if (source[cursor] === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(open + 1, cursor);
		}
		cursor += 1;
	}
	throw new Error("unbalanced refresh() body");
}

describe("RefreshGate 代际守卫（Q-QUA17）", () => {
	it("旧代结果被丢弃且不写回，最新代可写回", () => {
		const gate = new RefreshGate();
		const gen1 = gate.begin();
		const gen2 = gate.begin();

		expect(gate.discarded).toBe(0);
		// 先到的旧代结果：判否且计入丢弃
		expect(gate.isCurrent(gen1)).toBe(false);
		expect(gate.discarded).toBe(1);
		// 后到的新代结果：放行，不再累加丢弃
		expect(gate.isCurrent(gen2)).toBe(true);
		expect(gate.discarded).toBe(1);
	});
});

describe("RefreshGate 单飞与尾随合并（Q-PER2）", () => {
	it("并发三次 tryBegin 只放行一轮，结束补跑一轮，最终只多一次采集", () => {
		const gate = new RefreshGate();

		const first = gate.tryBegin();
		const second = gate.tryBegin();
		const third = gate.tryBegin();

		expect([first.run, second.run, third.run]).toEqual([true, false, false]);
		expect(gate.pendingCount).toBe(2);
		expect(gate.needsAnotherPass).toBe(true);

		// end 后放行补跑：pending 归零，需要补跑
		expect(gate.end()).toBe(true);
		expect(gate.pendingCount).toBe(0);
		expect(gate.needsAnotherPass).toBe(false);

		// 补跑那一轮占用单飞位，拿到的代际比首轮新
		const trailing = gate.tryBegin();
		expect(trailing.run).toBe(true);
		expect(trailing.gen).toBeGreaterThan(first.gen);
		expect(gate.isCurrent(trailing.gen)).toBe(true);
		expect(gate.isCurrent(first.gen)).toBe(false);
		expect(gate.end()).toBe(false);
	});

	it("没有合并请求时 end() 不需要补跑", () => {
		const gate = new RefreshGate();
		gate.tryBegin();
		expect(gate.end()).toBe(false);
		expect(gate.needsAnotherPass).toBe(false);
	});
});

describe("view.ts 的接线合同", () => {
	it("refresh() 体内先取代际、isCurrent 至少两处、取代早于第一次判代", () => {
		const body = refreshBody(viewSource());
		// Q-QUA17 的 begin 由 Q-PER2 的 tryBegin 内部完成，取代仍是入口第一件事
		const takeGen = body.indexOf("this.refreshGate.tryBegin()");
		expect(takeGen).toBeGreaterThan(-1);
		const firstIsCurrent = body.indexOf("this.refreshGate.isCurrent(");
		expect(firstIsCurrent).toBeGreaterThan(-1);
		expect(takeGen).toBeLessThan(firstIsCurrent);
		expect((body.match(/this\.refreshGate\.isCurrent\(/g) || []).length).toBeGreaterThanOrEqual(2);
	});

	it("refresh() 内含 try/finally，并在 finally 里调 end() 决定是否补跑", () => {
		const body = refreshBody(viewSource());
		const tryIndex = body.indexOf("try {");
		const finallyIndex = body.indexOf("} finally {");
		expect(tryIndex).toBeGreaterThan(-1);
		expect(finallyIndex).toBeGreaterThan(tryIndex);
		expect(body.slice(finallyIndex).includes("this.refreshGate.end()")).toBe(true);
	});

	it("刷新签名与既有调用点不变", () => {
		expect(
			viewSource().includes("async refresh(): Promise<void> {")
		).toBe(true);
		for (const file of [
			"src/main.ts",
			"src/ui/view-chrome.ts",
			"src/ui/view-approvals.ts",
		]) {
			const source = readFileSync(`${root}${file}`, "utf8");
			expect(source).toMatch(/view\.refresh\(\)|this\.refresh\(\)/);
		}
	});
});
