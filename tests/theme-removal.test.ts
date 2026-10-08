import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
	class Stub {}
	return new Proxy({ __esModule: true }, {
		get: (target, key) => (key in target ? target[key as keyof typeof target] : key === "then" ? undefined : Stub),
		has: () => true,
	});
});

const { normalizeVisualTheme } = await import("../src/settings");

// 2026-10-08：移除 Macintosh（system-classic）与 Swiss（swiss-modern）两套主题。
const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");

describe("removed Macintosh and Swiss themes", () => {
	it("moves saved selections to the Bauhaus theme instead of the dark fallback", () => {
		for (const legacy of ["system-classic", "macintosh-workstation", "swiss-modern"]) {
			expect(normalizeVisualTheme(legacy)).toBe("geometric-modern");
		}
		expect(normalizeVisualTheme("paper-ink")).toBe("paper-ink");
		expect(normalizeVisualTheme("unknown")).toBe("aurora");
	});

	it("no longer offers or styles either theme", () => {
		const settings = read("src/settings.ts");
		expect(settings).not.toContain('.addOption("system-classic"');
		expect(settings).not.toContain('.addOption("swiss-modern"');
		for (const sheet of ["styles.talos.css", "styles.quyuan-shell.css", "styles.ui-v2.css", "styles.layout-overrides.css"]) {
			const css = read(sheet);
			expect(css, sheet).not.toMatch(/system-classic|swiss-modern|tl-system-/);
		}
	});
});
