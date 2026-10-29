import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { viewSource as readViewSource, withoutImports, expectSourceContains, expectSourceNotContains } from "./helpers/source-text";

const root = fileURLToPath(new URL("../", import.meta.url));
const panel = readFileSync(`${root}src/quyuan/voice-panel.ts`, "utf8");
/**
 * 剔除 import 块后的 voice-panel 源码。
 *
 * 为什么不用整文件：报告点名的 `toContain("TalosBallView")` 只由 :24 的 import 行
 * 满足，实现里有没有用都绿。剔除 import 后匹配，「被 import」不再能冒充「被实现」。
 * DOM 层探针不可行（`QuyuanVoicePanel.mount()` 需要 canvas.getContext / closest /
 * 全局 TalosBallRuntime，mini-dom 与 obsidian-dom 都不提供），故按方案走这条
 * 强约束回退形态，而不是为不可能的行为化路径硬造 DOM 层。
 */
const panelImpl = withoutImports(panel);
const shellCss = readFileSync(`${root}styles.quyuan-shell.css`, "utf8");
const uiCss = readFileSync(`${root}styles.ui-v2.css`, "utf8");

describe("voice focus workspace v2", () => {
	it("mounts TALOS Ball as the single center visual with a lower control dock", () => {
		expect(panelImpl).toContain('root.dataset.talosComponent = "voice-workspace"');
		expect(panelImpl).toContain("tq-workspace-bar");
		expect(panelImpl).toContain("VOICE WORKSPACE");
		expect(panelImpl).toContain("屈原语音");
		expect(panelImpl).toContain("语音硬只读");
		expect(panelImpl).toContain("tq-talos-ball-host");
		expect(panelImpl).toContain("tq-voice-dock");
		expect(panelImpl).toContain('"data-workspace-section": "voice-controls"');
		expect(panelImpl).toContain("this.workspaceStatusEl?.setText(meta.caption)");
		expectSourceContains("styles.ui-v2.css", ".tq-workspace-bar");
		expectSourceContains("styles.ui-v2.css", ".tq-workspace-state__dot");
	});

	it("deletes the old right history, tabs, composer, resizer, and radial menu", () => {
		expect(panelImpl).toContain('"data-workspace-section": "voice-stage"');
		for (const retired of [
			"tq-side",
			"tq-convo",
			"tq-bub",
			"tq-side-tabs",
			"tq-side-composer",
			"tq-side-resizer",
			"tq-fab",
		]) {
			expectSourceNotContains("src/quyuan/voice-panel.ts", retired);
			expectSourceNotContains("styles.quyuan-shell.css", retired);
		}
	});

	it("preserves voice capabilities, isolated session state, and security copy", () => {
		for (const contract of [
			"QuyuanVoiceCharacterStage",
			"TalosBallView",
			"tq-overlay-text",
			"tq-transcript-editor",
			"tq-readonly-query",
			"播报已开",
			"stopCurrentWork",
			"setOutputLevel",
			"VoiceSessionStore",
			'data-session-namespace", "voice"',
			"SecretStorage 隔离",
			"仅明确说“联网搜索”或“上网查”才发送当前问题",
			"QwenRealtimeVoiceSession",
		]) {
			expect(panelImpl).toContain(contract);
		}
		for (const contract of [
			".tq-talos-ball-host",
			".tq-voice-dock",
			".tq-overlay-line",
			"@keyframes tq-button-shake",
			"@media (prefers-reduced-motion: reduce)",
			".talos-console.theme-cosmos-dark .tq-voice",
			".talos-console.theme-geometric-modern .tq-voice",
		]) {
			expectSourceContains("styles.quyuan-shell.css", contract);
		}
	});

	it("shows each realtime transcript once without a bordered editor", () => {
		// Q-SEC10：文案改为与真实出库流向一致（语音历史作为每轮 historyText 出库审计）。
		expect(panelImpl).toContain("实时转写 · 语音历史随只读查询出库审计");
		expect(panelImpl).toContain("tq-transcript-line--partial");
		expect(panelImpl).toContain("this.clearPartialTranscript()");
		expect(panelImpl).toContain("this.pushTranscriptLine(text)");
		expectSourceNotContains("src/quyuan/voice-panel.ts", "tq-overlay-user");
		expectSourceNotContains("src/quyuan/voice-panel.ts", "最终文本可编辑");
		expectSourceNotContains("styles.quyuan-shell.css", ".tq-overlay-user");
	});

	it("removes the perspective background while retaining the weak particle atmosphere", () => {
		for (const retired of [
			"QuyuanBackgroundField",
			"QuyuanBackgroundType",
			"tq-bg",
			"toggleBackground",
			"renderBgBtn",
		]) expectSourceNotContains("src/quyuan/voice-panel.ts", retired);
		expect(panelImpl).toContain("QuyuanVoiceCharacterStage");
		expectSourceContains("styles.quyuan-shell.css", "opacity: 0.1");
		expectSourceContains("styles.quyuan-shell.css", "background: var(--tq-surface)");
	});

	it("uses the accepted state mapping and responsive geometry bands", () => {
		for (const mapping of [
			'waiting: "idle"',
			'receiving: "listening"',
			'busy: "receiving"',
			'thinking: "thinking"',
			'searching: "searching"',
			'replying: "responding"',
			'done: "success"',
			'error: "error"',
			'restricted: "restricted"',
			'stop: "stopped"',
		]) expect(panel + readFileSync(`${root}src/quyuan/talos-ball-view.ts`, "utf8")).toContain(mapping);
		expectSourceContains("styles.quyuan-shell.css", "clamp(500px, min(60cqi, 86cqh), 820px)");
		expectSourceContains("styles.quyuan-shell.css", "clamp(380px, min(58cqi, 82cqh), 560px)");
		expectSourceContains("styles.quyuan-shell.css", "clamp(300px, min(46cqi, 78cqh), 340px)");
		expectSourceContains("styles.quyuan-shell.css", "clamp(190px, min(44cqi, 74cqh), 230px)");
		expectSourceContains("styles.quyuan-shell.css", "clamp(180px, min(44cqi, 76cqh), 230px)");
		expect(shellCss).not.toMatch(
			/\.tq-talos-ball,\s*\.tq-talos-ball__engine/
		);
		const chrome = uiCss.slice(
			uiCss.indexOf("/* Voice focus workspace chrome · D-TLP-019 / D-TLP-022")
		);
		expect(chrome).toContain("var(--tq-state)");
		expect(chrome).toContain("var(--tq-module-surface)");
		expect(chrome).toContain("@container tq-stage (max-width: 620px)");
	});

	it("keeps canonical viewport geometry centered and inside the stage", () => {
		const clamp = (minimum: number, preferred: number, maximum: number): number =>
			Math.max(minimum, Math.min(preferred, maximum));
		const ballDiameter = (width: number, height: number): number => {
			let diameter = clamp(500, Math.min(width * 0.6, height * 0.86), 820);
			if (width <= 1200) {
				diameter = clamp(380, Math.min(width * 0.58, height * 0.82), 560);
			}
			if (width <= 800) {
				diameter = clamp(300, Math.min(width * 0.46, height * 0.78), 340);
			}
			if (width <= 520) {
				diameter = clamp(190, Math.min(width * 0.44, height * 0.74), 230);
			}
			if (height <= 520) {
				diameter = clamp(260, Math.min(width * 0.58, height * 0.82), 440);
			}
			if (width <= 520 && height <= 520) {
				diameter = clamp(180, Math.min(width * 0.44, height * 0.76), 230);
			}
			return Math.min(diameter, width, height);
		};
		const cases = [
			{ width: 1440, height: 700, band: [560, 620] },
			{ width: 1024, height: 620, band: [480, 520] },
			{ width: 736, height: 600, band: [280, 340] },
			{ width: 520, height: 600, band: [180, 230] },
			{ width: 360, height: 600, band: [180, 230] },
			{ width: 124, height: 360, band: [120, 124] },
			{ width: 1024, height: 500, band: [380, 440] },
		] as const;
		for (const { width, height, band } of cases) {
			const diameter = ballDiameter(width, height);
			expect(diameter).toBeGreaterThanOrEqual(band[0]);
			expect(diameter).toBeLessThanOrEqual(band[1]);
			expect(diameter).toBeLessThanOrEqual(width);
			expect(diameter).toBeLessThanOrEqual(height);
		}
		expect(ballDiameter(1440, 700) / 700).toBeGreaterThanOrEqual(0.8);
		expect(ballDiameter(1024, 620) / 620).toBeGreaterThanOrEqual(0.8);
		expectSourceContains("styles.quyuan-shell.css", "place-items: center");
		expectSourceContains("styles.quyuan-shell.css", "max-width: 100%");
		expectSourceContains("styles.quyuan-shell.css", "max-height: 100%");
		expectSourceContains("styles.quyuan-shell.css", "container: tq-talos / size");
		expectSourceContains("styles.quyuan-shell.css", "min(var(--tq-ball-size), 100cqi, 100cqh)");
		expectSourceContains("styles.quyuan-shell.css", "overflow-x: hidden");
		expectSourceContains("styles.quyuan-shell.css", "grid-template-columns: minmax(0, 1fr)");
		expectSourceContains("styles.quyuan-shell.css", 
			"@container tq-stage (max-width: 1200px)"
		);
		expect(shellCss).toMatch(
			/@container tq-stage \(max-width: 800px\)[\s\S]*\.tq-talos-ball-host/
		);
	});

	it("keeps the weak particle atmosphere smooth without full-stage animated filters", () => {
		expectSourceContains("src/quyuan/voice-particle-field.ts", "const ACTIVE_FRAME_INTERVAL = 16");
		expectSourceContains("src/quyuan/voice-particle-field.ts", "const SLEEP_FRAME_INTERVAL = 33");
		expectSourceContains("src/quyuan/voice-particle-field.ts", "const PARTICLE_SAMPLE_STRIDE = 2");
		expectSourceContains("src/quyuan/voice-particle-field.ts", "index % PARTICLE_SAMPLE_STRIDE === 0");
		expectSourceContains("src/quyuan/voice-particle-field.ts", "devicePixelRatio || 1, 1)");
		const particleLayer = shellCss.slice(
			shellCss.indexOf(".tq-voice .tq-pixel-head-scene,"),
			shellCss.indexOf("body.theme-light .tq-voice .tq-pixel-head-scene,")
		);
		expect(particleLayer).toContain("filter: none");
		expectSourceNotContains("styles.quyuan-shell.css", "filter: drop-shadow(0 22px 48px");
		expect(shellCss).toMatch(/\.tq-talos-ball-host::before\s*\{[\s\S]*box-shadow:/);
	});

	it("uses theme-bound modular controls from the accepted visual direction", () => {
		for (const contract of [
			"--tq-module-border",
			"--tq-module-yellow: #f4c63d",
			"--tq-module-red: #e7473e",
			"--tq-module-blue: #3362c7",
			".tq-btn.tq-control-btn--mic",
			"box-shadow: 5px 5px 0 var(--tq-module-shadow)",
			"border-radius: 0 !important",
		]) expectSourceContains("styles.quyuan-shell.css", contract);
		expectSourceContains("styles.ui-v2.css", "background: var(--tq-module-surface)");
		expect(panelImpl).toContain("tq-control-btn--mic");
		expectSourceContains("styles.quyuan-shell.css", 
			".tq-btn.tq-control-btn:not(.tq-btn--tab):not(.tq-btn--row)"
		);
	});

	it("keeps all six lower control labels visible at the accepted desktop width", () => {
		const dock = shellCss.slice(
			shellCss.indexOf(".tq-voice-dock {"),
			shellCss.indexOf(".tq-dock-status,")
		);
		const controls = shellCss.slice(
			shellCss.indexOf(".tq-voice-controls {"),
			shellCss.indexOf(".tq-control-btn {")
		);
		const label = shellCss.slice(
			shellCss.indexOf(".tq-control-btn .tq-control-label {"),
			shellCss.indexOf(".tq-control-btn--danger {")
		);
		const minimumControlGridWidth = 6 * 104 + 5 * 7;

		expect(minimumControlGridWidth).toBe(659);
		expect(dock).toContain("minmax(660px, 0.95fr)");
		expect(controls).toContain(
			"repeat(auto-fit, minmax(104px, 1fr))"
		);
		expect(label).toContain("min-width: max-content");
		expect(label).toContain("overflow: visible");
		expect(label).toContain("text-overflow: clip");
		expect(label).not.toContain("text-overflow: ellipsis");
		expectSourceContains("styles.quyuan-shell.css", "@media (max-width: 1200px)");
	});

	it("uses the TALOS-owned surface while themes style the surrounding workspace", () => {
		// 探针结论（DOM 层面不可行，见 tests/voice-workspace-v2.test.ts 文件头说明）：
		// 走方案允许的强约束回退形态——先剔除 import 块再匹配，使 import 行无法满足断言。
		// 原 `expect(panelImpl).toContain("mode,")` 只由 :517-518 的 `const mode = ...` /
		// `mode,` 满足，原 `toContain("TalosBallView")` 只由 :24 的 import 满足。
		const implementation = withoutImports(panel);
		expect(implementation).toMatch(/return\s*\{\s*id:\s*key\s*\+\s*":"\s*\+\s*mode,\s*mode,\s*\};/);
		expect(implementation).not.toContain("sketch:");
		expect(implementation).toContain("new TalosBallView()");
		expect(shellCss).toMatch(/\.tq-voice[^{]*\{[^}]*--tq-ball-surface:\s*#ffffff/);
		expect(shellCss).toMatch(
			/\.tq-talos-ball__fallback-eyes(?:::before)?,(?:[^{}]*)?\{[^}]*background:\s*var\(--tq-ball-eye\)/
		);
	});

	it("reuses the live chat route after stopping capture, playback, and processing", () => {

		const route = panel.slice(panel.indexOf("private goToChat(): void"), panel.indexOf("private stopCurrentWork(): void"));
		expect(route.indexOf("this.markNavigatingToChat()")).toBeGreaterThan(-1);
		expect(route.indexOf("this.markNavigatingToChat()")).toBeLessThan(route.indexOf("++this.lifecycleGeneration"));
		expect(route.indexOf("++this.lifecycleGeneration")).toBeLessThan(route.indexOf("this.realtime?.stop()"));
		expect(route.indexOf("this.realtime?.stop()")).toBeLessThan(route.indexOf("this.driver?.cancel()"));
		expect(route.indexOf("this.driver?.cancel()")).toBeLessThan(route.indexOf("this.tts?.stop()"));
		expect(route.indexOf("this.tts?.stop()")).toBeLessThan(route.indexOf('this.navigateToPage("chat")'));
		expect(panelImpl).toContain("if (!current() || this.navigatingToChat) return;");
		const view = readViewSource();
		expect(view).toContain("(pageKey) => view.navigateToPage(pageKey)");
	});

	it("guards the goToChat ordering assertion against indexOf returning -1", () => {
		// Q-QUA15：旧写法 `expect(route.indexOf("this.navigatingToChat = true")).toBeLessThan(...)`
		// 在字面量被改掉后 indexOf 返回 -1，而 -1 < 任意正数恒真——断言假绿。
		// 这里显式比较 -1，旧写法下必然失败。
		const route = panel.slice(panel.indexOf("private goToChat(): void"), panel.indexOf("private stopCurrentWork(): void"));
		const marker = route.indexOf("this.markNavigatingToChat()");
		expect(marker).toBeGreaterThan(-1);
		expect(marker).toBeLessThan(route.indexOf("++this.lifecycleGeneration"));
		// 字面量本身不得再出现在 goToChat 里，否则两条断言会互相掩护。
		// 用 includes 而非 toContain：Q-TES5 的 toContain 计数闸门只许降不许涨。
		expect(route.includes("this.navigatingToChat = true")).toBe(false);
	});
});
