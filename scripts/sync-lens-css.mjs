// 从 TALOS Lens 源码同步「Lens 界面语言」样式到 styles.lens.css。
// 用法：node scripts/sync-lens-css.mjs <Lens 仓库路径>
//
// 1. 按 Vite 的真实顺序收集 CSS：从 src/main.tsx 起按 import 语句深度优先遍历，
//    样式在第一次被引入时落位（与 Lens 打包后的层叠顺序一致，保证像素级一致）。
// 2. 作用域收口：Lens 规则本就挂在 #talos-data-app-preview 下；:root 令牌改挂到该根，
//    html/body/#root 等整页规则丢弃，其余未带根的选择器补上根前缀，绝不泄漏到 Obsidian。
// 3. 带外部文件的 @font-face 丢弃（插件内没有这些字体文件）。
// 4. 级联层拍平：Lens 少量规则写在 @layer 里（令牌与几个组件）。在 Lens 里它们只和浏览器默认
//    样式竞争；插件里 Obsidian 的无层规则会一律压过有层规则。因此把有层规则拍平、按层序提到最前，
//    并把根之后的部分包进 :where()（特异性降到与根相同）——Lens 的无层规则仍稳定胜出，
//    同时有层规则仍高于 Obsidian 的低特异性全局规则。
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_ID = "#talos-data-app-preview";
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lensRoot = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !existsSync(join(lensRoot, "src/main.tsx"))) {
	console.error("用法：node scripts/sync-lens-css.mjs <TALOS Lens 仓库路径>");
	process.exit(1);
}

function resolveImport(from, spec) {
	if (!spec.startsWith(".")) return null;
	const base = resolve(dirname(from), spec);
	for (const candidate of [base, `${base}.js`, `${base}.ts`, `${base}.tsx`, `${base}.jsx`, join(base, "index.js")]) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return null;
}

function collectCssOrder(entry) {
	const seen = new Set();
	const order = [];
	const visit = (file) => {
		if (seen.has(file)) return;
		seen.add(file);
		const text = readFileSync(file, "utf8");
		if (file.endsWith(".css")) {
			for (const match of text.matchAll(/@import\s+(?:url\()?["']([^"']+)["']\)?[^;]*;/g)) {
				const target = resolveImport(file, match[1]);
				if (target) visit(target);
			}
			order.push(file);
			return;
		}
		for (const match of text.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
			const target = resolveImport(file, match[1]);
			if (target) visit(target);
		}
	};
	visit(entry);
	return order;
}

// ---- 极简 CSS 结构扫描：只需区分语句、规则块与 at-rule 块 ----
function skipComment(css, i) {
	const end = css.indexOf("*/", i + 2);
	return end < 0 ? css.length : end + 2;
}

function matchBrace(css, open) {
	let depth = 0;
	let quote = null;
	for (let k = open; k < css.length; k++) {
		const c = css[k];
		if (quote) {
			if (c === "\\") { k++; continue; }
			if (c === quote) quote = null;
			continue;
		}
		if (css.startsWith("/*", k)) { k = skipComment(css, k) - 1; continue; }
		if (c === '"' || c === "'") quote = c;
		else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) return k;
	}
	throw new Error("Lens CSS 括号不平衡");
}

function splitTopLevel(selector) {
	const parts = [];
	let depth = 0;
	let current = "";
	for (const c of selector) {
		if (c === "(" || c === "[") depth++;
		else if (c === ")" || c === "]") depth--;
		if (c === "," && depth === 0) { parts.push(current); current = ""; }
		else current += c;
	}
	parts.push(current);
	return parts.map((part) => part.trim()).filter(Boolean);
}

export function scopeSelector(selector) {
	if (selector.includes(ROOT_ID)) return selector;
	if (/^(html|body|#root)\b/.test(selector)) return null;
	if (selector.startsWith(":root")) return ROOT_ID + selector.slice(":root".length);
	if (selector.startsWith("[data-talos-theme")) return ROOT_ID + selector;
	return `${ROOT_ID} ${selector}`;
}

const LAYER_ORDER = ["talos.reset", "talos.token", "talos.primitive", "talos.component", "talos.utility"];
const layered = new Map();

/** 有层规则拍平后的选择器：根之后的部分包进 :where()，特异性与根相同。 */
export function flattenLayerSelector(selector) {
	if (!selector.startsWith(ROOT_ID)) return selector;
	// 根自身的条件（如 [data-talos-theme="light"]、:not(...)）与后代部分都包进 :where()
	const match = /^#talos-data-app-preview((?:\[[^\]]*\]|:[\w-]+(?:\([^)]*\))?|\.[\w-]+)*)(.*)$/.exec(selector);
	if (!match) return selector;
	const compound = match[1];
	let rest = match[2].trim();
	let combinator = " ";
	if (/^[>+~]/.test(rest)) {
		combinator = ` ${rest[0]} `;
		rest = rest.slice(1).trim();
	}
	return `${ROOT_ID}${compound ? `:where(${compound})` : ""}${rest ? `${combinator}:where(${rest})` : ""}`;
}

export function scopeCss(css, layer = null) {
	let out = "";
	let i = 0;
	while (i < css.length) {
		const c = css[i];
		if (/\s/.test(c)) { out += c; i++; continue; }
		if (css.startsWith("/*", i)) { const end = skipComment(css, i); out += css.slice(i, end); i = end; continue; }
		let k = i;
		let depth = 0;
		let quote = null;
		for (; k < css.length; k++) {
			const ch = css[k];
			if (quote) { if (ch === "\\") { k++; continue; } if (ch === quote) quote = null; continue; }
			if (ch === '"' || ch === "'") quote = ch;
			else if (ch === "(") depth++;
			else if (ch === ")") depth--;
			else if (depth === 0 && (ch === "{" || ch === ";")) break;
		}
		if (k >= css.length) break;
		const prelude = css.slice(i, k).trim();
		if (css[k] === ";") {
			if (!/^@(import|charset|layer)\b/.test(prelude)) out += `${prelude};`;
			i = k + 1;
			continue;
		}
		const end = matchBrace(css, k);
		const body = css.slice(k + 1, end);
		i = end + 1;
		if (prelude.startsWith("@")) {
			const layerName = /^@layer\s+([\w.-]+)$/.exec(prelude)?.[1];
			if (layerName) {
				layered.set(layerName, (layered.get(layerName) ?? "") + scopeCss(body, layerName));
				continue;
			}
			if (/^@(-webkit-)?keyframes\b|^@property\b/.test(prelude)) { out += `${prelude}{${body}}`; continue; }
			if (/^@font-face\b/.test(prelude)) { if (!/url\(/.test(body)) out += `${prelude}{${body}}`; continue; }
			const inner = scopeCss(body, layer);
			if (inner.replace(/\/\*[\s\S]*?\*\//g, "").trim()) out += `${prelude}{${inner}}`;
			continue;
		}
		const selectors = splitTopLevel(prelude).map(scopeSelector).filter(Boolean).map((sel) => (layer ? flattenLayerSelector(sel) : sel));
		if (selectors.length) out += `${selectors.join(",")}{${body}}`;
	}
	return out;
}

const order = collectCssOrder(join(lensRoot, "src/main.tsx"));
let commit = "unknown";
try {
	commit = execFileSync("git", ["-C", lensRoot, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
} catch { /* 非 git 目录时只记录未知 */ }

const parts = [
	"/* GENERATED FILE — run `node scripts/sync-lens-css.mjs <Lens 仓库>`，不要手改。 */",
	`/* TALOS Lens 界面语言 · 源提交 ${commit} · ${order.length} 个样式文件 */`,
];
const unlayered = order.map((file) => `\n/* lens: ${relative(lensRoot, file)} */\n${scopeCss(readFileSync(file, "utf8"))}`);
const layerNames = [...LAYER_ORDER.filter((name) => layered.has(name)), ...[...layered.keys()].filter((name) => !LAYER_ORDER.includes(name))];
for (const name of layerNames) parts.push(`\n/* lens layer (flattened): ${name} */\n`, layered.get(name));
parts.push(...unlayered);
const output = resolve(pluginRoot, "styles.lens.css");
writeFileSync(output, `${parts.join("\n")}\n`);
console.log(`styles.lens.css ← ${order.length} files @ ${commit}`);
