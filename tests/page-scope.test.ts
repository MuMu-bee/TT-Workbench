import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Q-QUA16：`data-talos-page` 写的是 pageRouter.renderKey()，其值域就是
// TalosSecondaryPageKey（PAGE_ROUTES 把 overview 映射成 today/today），
// 因此 CSS 里任何 [data-talos-page="overview"] 都永远命中不到——Hero 的
// 隐藏规则反过来把今日页整体藏掉了。本文件用纯字符串切分 + admits() 判定，
// 不读构建产物 styles.css、不引入 postcss（它只是 vitest→vite 的传递依赖）。

const root = fileURLToPath(new URL("../", import.meta.url));

const PAGE_SCOPE_SOURCES = [
	"styles.talos.css",
	"styles.ui-v2.css",
	"styles.quyuan-shell.css",
	"styles.layout-overrides.css",
] as const;

const PAGE_SCOPE_ATTR = /\[data-talos-page=["']?([A-Za-z0-9_-]+)["']?\]/;
const PAGE_SCOPE_ATTR_ALL = /\[data-talos-page=["']?([A-Za-z0-9_-]+)["']?\]/g;
const NOT_FN = /:not\(([^()]*)\)/g;

/** 从 navigation-model.ts 的 TalosSecondaryPageKey 联合里取出渲染键值域。 */
function renderKeyDomain(): string[] {
	const source = readFileSync(`${root}src/ui/navigation-model.ts`, "utf8");
	const start = source.indexOf("export type TalosSecondaryPageKey");
	expect(start, "missing TalosSecondaryPageKey").toBeGreaterThan(-1);
	const end = source.indexOf(";", start);
	expect(end).toBeGreaterThan(start);
	const body = source.slice(start, end);
	const keys = Array.from(body.matchAll(/"([A-Za-z0-9_-]+)"/g), (m) => m[1]);
	expect(keys.length).toBeGreaterThan(0);
	return keys;
}

function stripComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function splitSelectorList(selector: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let current = "";
	for (const char of selector) {
		if (char === "(" || char === "[") depth += 1;
		else if (char === ")" || char === "]") depth -= 1;
		if (char === "," && depth === 0) {
			out.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim()) out.push(current.trim());
	return out;
}

export interface CssRule {
	file: string;
	selector: string;
	body: string;
}

/**
 * 纯字符串规则切分：只认 `{ … }`，跳过注释，按逗号切选择器列表
 * （括号/方括号内的逗号不切）。@media 等 at-rule 的前导块自身不入列，
 * 但块内的规则照常收进来——页面作用域判定只关心选择器形态。
 */
function parseRules(file: string, source: string): CssRule[] {
	const css = stripComments(source);
	const rules: CssRule[] = [];
	let statementStart = 0;
	let index = 0;
	while (index < css.length) {
		const char = css[index];
		if (char === "{") {
			const prelude = css.slice(statementStart, index).trim();
			if (prelude && !prelude.startsWith("@")) {
				let depth = 1;
				let cursor = index + 1;
				while (cursor < css.length && depth > 0) {
					if (css[cursor] === "{") depth += 1;
					else if (css[cursor] === "}") depth -= 1;
					cursor += 1;
				}
				const body = css.slice(index + 1, cursor - 1);
				for (const selector of splitSelectorList(prelude)) {
					rules.push({ file, selector, body });
				}
			}
			statementStart = index + 1;
		} else if (char === "}") {
			statementStart = index + 1;
		}
		index += 1;
	}
	return rules;
}

function pageScopesIn(selector: string): { positives: string[]; negatives: string[] } {
	const negatives: string[] = [];
	for (const match of selector.matchAll(NOT_FN)) {
		for (const scope of (match[1] ?? "").matchAll(PAGE_SCOPE_ATTR_ALL)) {
			negatives.push(scope[1]);
		}
	}
	const withoutNegatives = selector.replace(NOT_FN, "");
	const positives = Array.from(
		withoutNegatives.matchAll(PAGE_SCOPE_ATTR_ALL),
		(m) => m[1]
	);
	return { positives, negatives };
}

/** 该选择器是否可能命中 page：正向作用域必须含它，:not() 里不得含它。 */
function admits(selector: string, page: string): boolean {
	const { positives, negatives } = pageScopesIn(selector);
	if (negatives.includes(page)) return false;
	if (positives.length > 0 && !positives.includes(page)) return false;
	return true;
}

const rules: CssRule[] = PAGE_SCOPE_SOURCES.flatMap((file) =>
	parseRules(file, readFileSync(`${root}${file}`, "utf8"))
);

const domain = renderKeyDomain();

describe("页面作用域 data-talos-page", () => {
	it("源码 CSS 里不再出现渲染键值域外的页面作用域取值", () => {
		const known = new Set(domain);
		const outside: string[] = [];
		for (const rule of rules) {
			for (const match of rule.selector.matchAll(PAGE_SCOPE_ATTR_ALL)) {
				const value = match[1];
				if (!known.has(value)) outside.push(`${rule.file}: ${rule.selector}`);
			}
		}
		expect(outside).toEqual([]);
		// 值域本身仍含 today（证明上面这条不是空转）
		expect(domain.includes("today")).toBe(true);
	});

	it("今日页不再被 Hero 隐藏规则的页面作用域命中，且页面作用域 Hero 规则总数不变", () => {
		const heroRules = rules.filter(
			(rule) =>
				rule.selector.includes(".main > .hero") &&
				PAGE_SCOPE_ATTR.test(rule.selector)
		);
		expect(heroRules.filter((rule) => admits(rule.selector, "today"))).toEqual([]);
		// 不靠删规则达标：两条页面作用域的 Hero 规则仍在（今日页 + jarvis 页）
		expect(heroRules).toHaveLength(2);
	});

	it("翻转作用域后今日页的 .main padding 不静默丢光", () => {
		const paddingRules = rules.filter(
			(rule) =>
				/(^|[\s>])\.main(\s|$|[.:>])/.test(rule.selector) &&
				/\bpadding\b/.test(rule.body) &&
				PAGE_SCOPE_ATTR.test(rule.selector)
		);
		const values = (page: string) =>
			paddingRules
				.filter((rule) => admits(rule.selector, page))
				.map((rule) =>
					(/\bpadding\s*:\s*([^;]+)/.exec(rule.body)?.[1] ?? "").trim()
				);

		const today = values("today");
		const inbox = values("inbox");
		expect(today).toHaveLength(3);
		expect(inbox).toHaveLength(3);
		expect(new Set(today)).toEqual(new Set(["18px !important", "14px !important", "10px !important"]));
		expect(new Set(inbox)).toEqual(new Set(["18px !important", "14px !important", "10px !important"]));
	});
});
