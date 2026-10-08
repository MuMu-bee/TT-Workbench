import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Lens 界面语言样式：由 scripts/sync-lens-css.mjs 从 TALOS Lens 源码同步，不得泄漏到 Obsidian。
const root = fileURLToPath(new URL("../", import.meta.url));
const lens = readFileSync(`${root}styles.lens.css`, "utf8");
const host = readFileSync(`${root}styles.lens-host.css`, "utf8");
const build = readFileSync(`${root}build-styles.mjs`, "utf8");
const css = lens.replace(/\/\*[\s\S]*?\*\//g, "");

function styleRuleSelectors(text: string): string[] {
	const selectors: string[] = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "{") {
			const prelude = text.slice(start, i).trim();
			if (prelude && !prelude.startsWith("@") && !/^(from|to|[\d.]+%)(\s*,\s*(from|to|[\d.]+%))*$/.test(prelude)) selectors.push(prelude);
			start = i + 1;
		} else if (c === "}") {
			start = i + 1;
		} else if (c === ";") {
			start = i + 1;
		}
	}
	return selectors;
}

describe("synced Lens stylesheet", () => {
	it("is generated from the Lens source and records where it came from", () => {
		expect(lens).toMatch(/^\/\* GENERATED FILE — run `node scripts\/sync-lens-css\.mjs/);
		expect(lens).toMatch(/TALOS Lens 界面语言 · 源提交 [0-9a-f]{7,} · \d+ 个样式文件/);
		expect(lens).toContain("/* lens: src/workspace.css */");
		expect(lens.indexOf("/* lens: src/workspace.css */")).toBeLessThan(lens.indexOf("/* lens: src/overview.css */"));
	});

	it("keeps every style rule under the Lens root so nothing leaks into Obsidian", () => {
		const selectors = styleRuleSelectors(css);
		expect(selectors.length).toBeGreaterThan(1000);
		const leaking = selectors.filter((selector) => !selector.includes("#talos-data-app-preview"));
		expect(leaking).toEqual([]);
		expect(css).not.toMatch(/(^|[},])\s*(html|body|:root)\s*[,{]/);
	});

	it("flattens cascade layers so Lens rules are not overridden by unlayered Obsidian rules", () => {
		expect(css).not.toContain("@layer");
		expect(css).toContain("#talos-data-app-preview :where(.lens-workspace-tabs button)");
		expect(css).toContain('#talos-data-app-preview:where([data-talos-theme="light"])');
		// 有层规则提到最前，Lens 的无层规则（如令牌别名）在后，同特异性时稳定胜出
		expect(lens.indexOf("lens layer (flattened): talos.token")).toBeLessThan(lens.indexOf("--talos-action-current-bg:var(--ta-blue-bg)"));
	});

	it("loads the host reset before the Lens rules and never reverts icons or native settings", () => {
		expect(build.indexOf("readFileSync(lensHostSource")).toBeLessThan(build.indexOf("readFileSync(lensSource"));
		expect(host).toContain("#talos-data-app-preview :where(:not(svg, svg *, .talos-lens-native, .talos-lens-native *))");
		expect(host).toContain("all: revert;");
	});
});
