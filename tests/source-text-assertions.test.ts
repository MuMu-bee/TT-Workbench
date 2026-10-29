import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expectCssRuleContains, expectSourceContains, withoutImports } from "./helpers/source-text";

const root = fileURLToPath(new URL("../", import.meta.url));

/**
 * Q-TES5：把「大量测试只对源码文本做 toContain」的可回退面收窄。
 *
 * 分类结论（对 `for f in tests/*.test.ts tests/*.test.mjs; do grep -q 'from "../src/' "$f" || echo; done`
 * 得到的 45 个文件逐个判定）：
 *   - 40 个读源码文本 / CSS 文本（本文件的闸门只针对这一类的下界）；
 *   - 4 个是 TalosBall 资产/契约测试（talos-ball-data-contract、
 *     talos-ball-pose-equivalence、talos-ball-runtime-integrity、
 *     talos-ball-state-contract，均为 .test.mjs，测 vendored 运行时与夹具，
 *     硬塞 src import 只会制造无意义依赖，验收明确排除）；
 *   - 1 个是本轮新增的 tests/module-boundaries.test.ts（import 的是 scripts/ 下的
 *     守卫脚本，其路径不在 `from "../src/` 前缀命中范围）。
 */

const TALOS_BALL_ASSET_TESTS = [
	"talos-ball-data-contract.test.mjs",
	"talos-ball-pose-equivalence.test.mjs",
	"talos-ball-runtime-integrity.test.mjs",
	"talos-ball-state-contract.test.mjs",
] as const;

/** 从文件头出现的 import 块判断：该文件是否 import 了产品源码。 */
function importsProductSource(file: string): boolean {
	return /from\s+["']\.\.\/src\//.test(readFileSync(`${root}tests/${file}`, "utf8"));
}

describe("source-text assertion discipline", () => {
	it("counts every toContain call under tests/ and never lets it grow past the cap", () => {
		const cap = JSON.parse(
			readFileSync(`${root}tests/fixtures/source-text-toContain-cap.json`, "utf8")
		) as { cap: number; comment: string };
		let total = 0;
		const count = (directory: string): void => {
			for (const entry of readdirSync(`${root}${directory}`, { withFileTypes: true })) {
				const next = `${directory}/${entry.name}`;
				if (entry.isDirectory()) {
					if (entry.name === "node_modules") continue;
					count(next);
					continue;
				}
				if (!/\.(?:ts|mjs)$/.test(entry.name)) continue;
				total += readFileSync(`${root}${next}`, "utf8").split("toContain(").length - 1;
			}
		};
		count("tests");
		// 单调下降闸门：新的纯文本断言不再回涨（Q-TES5 的核心目的）。
		expect(total).toBeLessThanOrEqual(cap.cap);
		expect(Number.isSafeInteger(cap.cap)).toBe(true);
	});

	it("keeps the four TalosBall asset contract tests out of the src-import requirement", () => {
		for (const file of TALOS_BALL_ASSET_TESTS) {
			// 资产契约测试测的是 vendored 运行时与夹具，不该被要求 import src；
			// 这条断言把「不 import」这个事实钉住，防止有人为了让统计好看硬塞 import。
			expect(importsProductSource(file)).toBe(false);
		}
	});

	it("never asserts importability instead of implementation", () => {
		// expect(<整文件源码>).toContain("X") 能被一行 import 满足。这个文件曾有一条
		// 只由 voice-panel.ts:24 的 import 满足的断言；现在先用 withoutImports 剥掉
		// import 块再匹配，这条断言变成对实现的可判定断言。
		const panel = readFileSync(`${root}src/quyuan/voice-panel.ts`, "utf8");
		expect(panel).toContain("TalosBallView");
		expect(withoutImports(panel)).toContain("new TalosBallView()");
		// 反证：剥掉 import 后，纯粹的「被 import」不再能满足匹配。
		expect(/^import[\s\S]*?from\s+["']\.\/talos-ball-view["'];?$/m.test(
			withoutImports(panel)
		)).toBe(false);
	});
});

describe("restricted source/CSS entry points", () => {
	it("expectSourceContains requires an explicit module path and matches the implementation", () => {
		const source = expectSourceContains("src/quyuan/voice-panel.ts", "new TalosBallView()");
		expect(source).not.toMatch(/^import\s.*talos-ball-view/m);
		expect(() => expectSourceContains(
			"src/quyuan/voice-panel.ts",
			"this identifier is nowhere in the implementation"
		)).toThrow(/不含/);
	});

	it("expectSourceContains accepts a strong regex that an import line cannot satisfy", () => {
		expect(() => expectSourceContains(
			"src/quyuan/voice-panel.ts",
			/^import[\s\S]*?from\s+["']\.\/talos-ball-view["'];?$/m
		)).toThrow(/不匹配/);
		expect(() => expectSourceContains(
			"src/quyuan/voice-panel.ts",
			/return\s*\{\s*id:\s*key\s*\+\s*":"\s*\+\s*mode,/
		)).not.toThrow();
	});

	it("expectCssRuleContains locates the selector block before matching the declaration", () => {
		expect(() => expectCssRuleContains(
			"styles.quyuan-shell.css",
			/\.tq-voice/,
			/--tq-ball-surface:\s*#ffffff/
		)).not.toThrow();
		// 同样的字符串写在别的选择器块里不算通过。
		expect(() => expectCssRuleContains(
			"styles.quyuan-shell.css",
			/\.tq-dock-status/,
			/--tq-ball-surface:\s*#ffffff/
		)).toThrow();
	});
});
