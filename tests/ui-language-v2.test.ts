import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { viewSource as readViewSource, expectSourceContains } from "./helpers/source-text";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const view = readViewSource();
const styles = readFileSync(`${projectRoot}styles.ui-v2.css`, "utf8");
const build = readFileSync(`${projectRoot}build-styles.mjs`, "utf8");

describe("TALOS unified interface language v2 foundation", () => {
	it("assigns every route to one of the five page archetypes", () => {
		for (const archetype of [
			"dashboard",
			"execution",
			"knowledge",
			"workspace",
			"settings",
		]) {
			expect(view).toContain(`"${archetype}"`);
		}
		expect(view).toContain('"data-talos-archetype"');
	});

	it("renders all business page headers through one shared primitive", () => {
		// 页面渲染已拆到 src/ui/pages，按相对路径从同一个共享模块引入
		expect(view).toMatch(/from "(?:\.\/ui|\.\.)\/page-primitives"/);
		expect(view).toContain("renderTalosPageHeader(parent");
		expectSourceContains("src/ui/page-primitives.ts", 'data.talosComponent = "page-header"'.replace("data.", "dataset."));
		expectSourceContains("src/ui/page-primitives.ts", "metrics.slice(0, 4)");
		expectSourceContains("src/ui/page-primitives.ts", "actions.slice(0, 3)");
	});

	it("keeps interactive metrics keyboard reachable", () => {
		expectSourceContains("src/ui/page-primitives.ts", 'setAttribute("role", "button")');
		expectSourceContains("src/ui/page-primitives.ts", 'setAttribute("tabindex", "0")');
		expectSourceContains("src/ui/page-primitives.ts", 'event.key !== "Enter"');
	});

	it("defines semantic tokens and reference-theme mappings", () => {
		for (const token of [
			"--talos-ui-canvas",
			"--talos-ui-surface",
			"--talos-ui-ink",
			"--talos-ui-line",
			"--talos-ui-accent",
			"--talos-ui-success",
			"--talos-ui-warning",
			"--talos-ui-danger",
			"--talos-ui-focus",
		]) {
			expectSourceContains("styles.ui-v2.css", token);
		}
		expectSourceContains("styles.ui-v2.css", ".talos-console.theme-geometric-modern");
	});

	it("builds the cohesive v2 layer after validated legacy overrides", () => {
		const layout = build.indexOf("readFileSync(layoutOverridesSource");
		const uiV2 = build.indexOf("readFileSync(uiV2Source");
		expect(layout).toBeGreaterThan(-1);
		expect(uiV2).toBeGreaterThan(layout);
	});

	it("uses container reflow without forcing the page-content height", () => {
		expectSourceContains("styles.ui-v2.css", "container: talos-ui-page / inline-size");
		expectSourceContains("styles.ui-v2.css", "@container talos-ui-page (max-width: 900px)");
		expectSourceContains("styles.ui-v2.css", "@container talos-ui-page (max-width: 560px)");
		expect(styles).not.toMatch(/\.talos-ui-page\s*\{[^}]*min-height/s);
		expect(styles).not.toMatch(/\.talos-ui-page\s*\{[^}]*max-height/s);
		expect(styles).not.toMatch(/\.talos-ui-page\s*\{[^}]*flex:/s);
	});

	it("keeps every non-today pixel bot inside the compact header safe area", () => {
		const stageSelector =
			'.talos-console[data-talos-archetype]:not([data-talos-page="today"])\n\t.module-hero .talos-pixel-patrol.talos-ui-page-header__scene.in-module-hero';
		const botSelector =
			'.talos-console[data-talos-archetype]:not([data-talos-page="today"])\n\t.module-hero .talos-pixel-patrol.in-module-hero .talos-pixel-bot';
		const trackSelector =
			'.talos-console[data-talos-archetype]:not([data-talos-page="today"])\n\t.module-hero .talos-pixel-patrol.in-module-hero .talos-pixel-track';

		expectSourceContains("styles.ui-v2.css", stageSelector);
		expectSourceContains("styles.ui-v2.css", botSelector);
		expectSourceContains("styles.ui-v2.css", trackSelector);
		expectSourceContains("styles.ui-v2.css", "--talos-pixel-safe-stage-height: 86px");
		expectSourceContains("styles.ui-v2.css", "--talos-pixel-safe-bot-top: 28px");
		expectSourceContains("styles.ui-v2.css", "--talos-pixel-safe-track-bottom: 4px");
		expect(styles).toMatch(
			/\.talos-pixel-patrol\.talos-ui-page-header__scene\.in-module-hero\s*\{[^}]*height:\s*var\(--talos-pixel-safe-stage-height\)[^}]*overflow:\s*hidden[^}]*--pixel-scale:\s*1\.25/s
		);
		expect(styles).toMatch(
			/\.talos-pixel-patrol\.in-module-hero \.talos-pixel-track\s*\{[^}]*top:\s*auto[^}]*bottom:\s*var\(--talos-pixel-safe-track-bottom\)/s
		);
	});

	it("preserves every theme identity and the established motion surfaces", () => {
		for (const theme of [
			"theme-aurora",
			"theme-cosmos-dark",
			"theme-animal-island",
			"theme-data-stream",
			"theme-soft-relief",
			"theme-geometric-modern",
			"theme-executive-brief",
			"theme-paper-ink",
		]) {
			expect(view).toContain(`"${theme}"`);
		}

		expect(view).toContain("buildThemeAtmosphere(view, bg)");
		expect(view).toContain("buildPixelPatrol(view, hero)");
		for (const surface of [
			".cosmos-scene",
			".data-rain",
			".geometry-field",
			".talos-pixel-patrol",
		]) {
			expectSourceContains("styles.talos.css", surface);
		}
		expectSourceContains("styles.quyuan-shell.css", ".tq-voice");
		expectSourceContains("styles.ui-v2.css", "@media (prefers-reduced-motion: reduce)");
		expect(styles).not.toMatch(
			/(?:cosmos-scene|data-rain|geometry-field|talos-pixel-patrol|tq-voice)[^{]*\{[^}]*display:\s*none/s
		);
	});

});
