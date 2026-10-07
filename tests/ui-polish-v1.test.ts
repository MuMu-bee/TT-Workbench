import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// UI polish v1（2026-10-07）的样式合同。这些规则追加在最后加载的 styles.ui-v2.css 末尾，
// 用更高优先级覆盖各主题的旧规则；构建后的 styles.css 也必须保留它们的顺序。
const root = fileURLToPath(new URL("../", import.meta.url));
const css = readFileSync(`${root}styles.ui-v2.css`, "utf8");
const polish = css.slice(css.indexOf("UI polish v1"));
const businessHeader =
	'.talos-console[data-talos-archetype]:not([data-talos-page="overview"]):not([data-talos-page="jarvis"])\n\t.talos-ui-page-header.module-hero';

function rule(selectorStart: string): string {
	const start = polish.indexOf(selectorStart);
	expect(start, `missing rule: ${selectorStart}`).toBeGreaterThan(-1);
	return polish.slice(start, polish.indexOf("}", start));
}

describe("UI polish v1", () => {
	it("is the last block of the last style source so it outranks theme rules", () => {
		expect(css.indexOf("UI polish v1")).toBeGreaterThan(css.indexOf("Pixel scene safe area"));
		const build = readFileSync(`${root}build-styles.mjs`, "utf8");
		for (const earlier of ["talosSource", "quyuanShellSource", "layoutOverridesSource"]) {
			expect(build.lastIndexOf("readFileSync(uiV2Source")).toBeGreaterThan(build.lastIndexOf(`readFileSync(${earlier}`));
		}
	});

	it("brings business page titles back to the page type scale with a compact header", () => {
		expect(rule(`${businessHeader} .module-hero-copy h1.module-hero-title`)).toContain("font-size: var(--talos-type-page)");
		expect(rule(`${businessHeader} .module-hero-main`)).toContain("min-height: 0");
		expect(rule(`${businessHeader} .talos-ui-page-header__description`)).toContain("white-space: nowrap");
		const scene = rule(`${businessHeader} .talos-pixel-patrol.talos-ui-page-header__scene.in-module-hero`);
		expect(scene).toContain("--talos-pixel-safe-stage-height: 56px");
		expect(scene).toContain("--pixel-scale: 0.9");
	});

	it("shows the trend score once, in theme ink and body size", () => {
		const score = rule(".talos-console[data-talos-archetype] .trend-head .score");
		expect(score).toContain("background: none");
		expect(score).toContain("-webkit-text-fill-color: currentColor");
		expect(score).toContain("font-size: var(--talos-type-body)");
	});

	it("drops nested hard shadows inside the page header but keeps hover feedback", () => {
		expect(rule(`${businessHeader} :is(.module-hero-main`)).toContain("box-shadow: none");
		expect(rule(`${businessHeader} .module-hero-stat.is-interactive:is(:hover, :focus-visible)`)).toContain("3px 3px 0");
	});

	it("keeps header metrics inside the theme palette", () => {
		expect(rule(`${businessHeader} {`)).toContain("--module-unified-ac: var(--ac)");
		expect(rule(`${businessHeader} .module-hero-stat {`)).toContain("--stat-ac: var(--talos-ui-ink)");
	});

	it("lets long diagnostic rows ellipsize instead of widening their panel", () => {
		expect(rule(".talos-console[data-talos-archetype] .detail-list {")).toContain("grid-template-columns: minmax(0, 1fr)");
		expect(rule(".talos-console[data-talos-archetype] .detail-list > .detail-row")).toContain("min-width: 0");
	});

	it("keeps dashed empty states but at a compact height", () => {
		expect(rule(".talos-console[data-talos-archetype] .empty {")).toContain("min-height: 44px");
	});

	it("lays out assistant pages as a flex column so the chat surface fills below the tabs", () => {
		const main = rule('.talos-console:is(.section-chat, [data-talos-page="chat"], [data-talos-page="jarvis"]) .main {');
		expect(main).toContain("display: flex !important");
		expect(main).toContain("flex-direction: column !important");
		expect(rule(".talos-page-tabs:not(.is-hidden) ~ .page-content")).toContain("flex: 1 1 auto !important");
	});

	it("keeps the animated pixel patrol in every business page header", () => {
		const modules = readFileSync(`${root}src/ui/view-modules.ts`, "utf8");
		expect(modules).toContain("const scene = buildPixelPatrol(view, hero);");
		const base = readFileSync(`${root}styles.talos.css`, "utf8");
		expect(base).toContain("animation: tl-pixel-patrol 12s steps(42,end) infinite;");
		expect(base).toContain("@keyframes tl-pixel-commute");
		// 本轮新增的覆盖规则不得关闭或替换像素小人的动画
		for (const block of polish.split("}")) {
			if (/talos-pixel|pixel-bot|pixel-patrol/.test(block)) expect(block).not.toMatch(/animation\s*:/);
		}
	});
});
