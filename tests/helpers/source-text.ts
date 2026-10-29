import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 源码文本合同测试的统一读取入口。TalosView 的页面、图表、审批区等已拆到
// src/ui 下的独立模块，TalosPlugin 的语音、诊断、Provider 等拆到 src/plugin；
// 按整体读取，"包含 / 不包含" 断言不会因代码换文件而失效。

const root = fileURLToPath(new URL("../../", import.meta.url));

function read(path: string): string {
	return readFileSync(`${root}${path}`, "utf8");
}

function modulesIn(dir: string): string[] {
	return readdirSync(`${root}${dir}`)
		.filter((name) => name.endsWith(".ts"))
		.sort()
		.map((name) => `${dir}/${name}`);
}

export const VIEW_SOURCE_FILES: readonly string[] = [
	"src/view.ts",
	"src/ui/talos-view-model.ts",
	"src/ui/view-chrome.ts",
	"src/ui/view-approvals.ts",
	"src/ui/view-cosmos.ts",
	"src/ui/view-modules.ts",
	...modulesIn("src/ui/pages"),
	...modulesIn("src/ui/charts"),
];

/** TalosView 及其拆分模块的完整源码。 */
export function viewSource(): string {
	return VIEW_SOURCE_FILES.map(read).join("\n");
}

export const PLUGIN_SOURCE_FILES: readonly string[] = [
	"src/main.ts",
	...modulesIn("src/plugin"),
];

/** TalosPlugin 及其拆分到 src/plugin 的模块的完整源码。 */
export function pluginSource(): string {
	return PLUGIN_SOURCE_FILES.map(read).join("\n");
}

/** 取出一个导出函数的完整源码（到下一个顶层 export 为止）。 */
export function functionSource(source: string, name: string): string {
	const start = source.search(new RegExp(`^export (?:async )?function\\*? ${name}\\(`, "m"));
	if (start < 0) throw new Error(`function not found: ${name}`);
	const next = source.slice(start + 1).search(/^export /m);
	return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

/**
 * 剔除全部顶层 import 块后的源码。
 *
 * 用途：把「该标识符出现在实现里」与「它只是被 import 进来」区分开。
 * `expect(wholeFile).toContain("TalosBallView")` 会被一行 import 满足，
 * 即使实现里根本没用到它；先去掉 import 再匹配才有判别力。
 */
export function withoutImports(source: string): string {
	return source
		.replace(/^import\s+(?:type\s+)?[\s\S]*?from\s+["'][^"']+["'];?[ \t]*$/gm, "")
		.replace(/^import\s+["'][^"']+["'];?[ \t]*$/gm, "");
}

/**
 * 受限的源码文本断言入口：必须显式写模块路径，不允许对整文件拼接变量做裸 toContain。
 *
 * - `pattern` 为字符串时按字面量匹配去 import 后的源码（仍比裸 toContain 强：import 行无法满足）。
 * - `pattern` 为正则时在去 import 后的源码上匹配，用于「先定位选择器块再匹配」这类强约束，
 *   例如 `/\.tq-voice[^{]*\{[^}]*--tq-ball-surface:\s*#ffffff/`。
 */
export function expectSourceContains(
	modulePath: string,
	pattern: string | RegExp,
): string {
	const source = withoutImports(read(modulePath));
	if (typeof pattern === "string") {
		if (!source.includes(pattern)) {
			throw new Error(`${modulePath}（已剔除 import 块）不含 ${JSON.stringify(pattern)}`);
		}
		return source;
	}
	if (!pattern.test(source)) {
		throw new Error(`${modulePath}（已剔除 import 块）不匹配 ${pattern}`);
	}
	return source;
}

/**
 * `expectSourceContains` 的反面：断言去 import 后的源码**不含**该片段。
 *
 * 用于「某个退役实现/样式不得回流」的守护。比裸 `expect(wholeFile).not.toContain`
 * 略强：匹配面先剔掉 import 块，人不能靠保留一行 import 就绕过检查。
 */
export function expectSourceNotContains(
	modulePath: string,
	pattern: string | RegExp,
): string {
	const source = withoutImports(read(modulePath));
	if (typeof pattern === "string") {
		if (source.includes(pattern)) {
			throw new Error(`${modulePath}（已剔除 import 块）不应包含 ${JSON.stringify(pattern)}`);
		}
		return source;
	}
	if (pattern.test(source)) {
		throw new Error(`${modulePath}（已剔除 import 块）不应匹配 ${pattern}`);
	}
	return source;
}

/**
 * 受限的 CSS 断言入口：先定位选择器块再块内匹配，避免「文件里任何地方出现该字符串」
 * 就算通过的弱断言。
 *
 * `selector` 按正则片段给出（如 `\\.tq-voice`），`declaration` 必须在**某一个**命中
 * 块内成立。同一个选择器可能出现多次（.tq-voice 既有主题变量块又有布局块），
 * 所以逐个块试，命中任意一个即通过；全都不中才失败。
 */
export function expectCssRuleContains(
	cssPath: string,
	selector: RegExp,
	declaration: RegExp,
): string {
	const css = read(cssPath);
	// 不用 lastIndex 有状态的整体正则，逐块扫描。
	const blockRule = new RegExp(`${selector.source}[^{}]*\\{[^}]*\\}`, "gm");
	const blocks = [...css.matchAll(blockRule)].map((match) => match[0]);
	if (blocks.length === 0) throw new Error(`${cssPath} 找不到选择器块 ${selector}`);
	const hit = blocks.find((block) => declaration.test(block));
	if (hit === undefined) {
		throw new Error(
			`${cssPath} 的 ${blocks.length} 个选择器块 ${selector} 都不匹配 ${declaration}`
		);
	}
	return hit;
}
