import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Lens 界面里的屈原语音：插件语音面板按 Lens quyuan-voice 构图重排（2026-10-08 真机修复）。
const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");
const skin = read("styles.lens-voice.css");
const host = read("styles.lens-host.css");
const build = read("build-styles.mjs");

describe("Quyuan voice in the Lens interface", () => {
	it("loads after the Lens rules and mounts into a Lens voice host", () => {
		expect(build.indexOf("readFileSync(lensSource")).toBeLessThan(build.indexOf("readFileSync(lensVoiceSource"));
		expect(read("src/ui/lens/lens-voice.ts")).toContain('{ class: "lens-quyuan-voice" }');
	});

	it("keeps the TalosBall and particle stage out of the element reset", () => {
		expect(host).toContain(".tq-talos-stage, .tq-talos-stage *, .tq-pixel-head-scene, .tq-pixel-head-scene *");
	});

	it("lays the panel out as Lens's stage + dock with its two-column controls", () => {
		expect(skin).toMatch(/\.lens-quyuan-voice \.tq-body \{[^}]*grid-template-columns: minmax\(0, 1\.32fr\) minmax\(270px, 0\.88fr\);/);
		expect(skin).toMatch(/\.lens-quyuan-voice \.tq-voice-controls \{[^}]*grid-template-columns: 1fr 1fr;/);
	});

	it("restores the ball size that Lens's icon rule and the classic max-height would shrink", () => {
		expect(skin).toMatch(/\.tq-talos-ball-runtime > svg \{\s*width: 100%;\s*height: 100%;/);
		expect(skin).toMatch(/\.tq-talos-ball-host \{[^}]*max-height: none;/);
	});

	it("overrides the classic !important button colours with Lens's", () => {
		expect(skin).toMatch(/:is\(\.tq-control-btn, \.tq-send-btn, \.tq-btn\) \{[^}]*background: var\(--ta-bg\) !important;/);
		expect(skin).toMatch(/\.tq-control-btn--mic \{[^}]*background: var\(--ta-ink\) !important;/);
	});
});
