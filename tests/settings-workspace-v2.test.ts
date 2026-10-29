import { readFileSync } from "node:fs";
import { expectSourceContains, expectSourceNotContains } from "./helpers/source-text";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const uiCss = readFileSync(`${root}styles.ui-v2.css`, "utf8");

describe("settings configuration workspace v2", () => {
	it("keeps five user-facing categories as described, accessible tabs", () => {
		expectSourceContains("src/settings.ts", "const TALOS_SETTING_TABS");
		for (const label of [
			"界面",
			"库与数据",
			"对话与模型",
			"屈原 · 语音",
		]) {
			expectSourceContains("src/settings.ts", `label: "${label}"`);
		}
		expectSourceContains("src/settings.ts", 'createEl("button"');
		expectSourceContains("src/settings.ts", 'role: "tab"');
		expectSourceContains("src/settings.ts", '"aria-selected"');
		expectSourceContains("src/settings.ts", 'event.key === "ArrowDown"');
		expectSourceContains("src/settings.ts", 'event.key === "Home"');
	});

	it("adds current-category context without creating a second settings renderer", () => {
		// 2026-10-08：分类大标题与标签栏重复，已移除；版权说明统一在底部。
		expectSourceNotContains("src/settings.ts", "CONFIGURATION WORKSPACE");
		expectSourceContains("src/settings.ts", 'cls: "talos-settings-footer"');
		expectSourceContains("src/settings.ts", "content.dataset.settingsTab = active.id");
		expectSourceContains("src/settings.ts", "renderInto(containerEl: HTMLElement)");
		expectSourceContains("src/settings.ts", "this.renderInto(target)");
		expectSourceContains("src/settings.ts", "new Setting(c)");
		expectSourceNotContains("src/settings.ts", "renderWorkbench");
		expectSourceNotContains("src/settings.ts", "ClaudianSettingTab");
		// API 配置与对话侧栏共用「自定义 API」窗口，设置页只显示摘要与编辑入口。
		expectSourceContains("src/settings.ts", "customApiSummary(port, kind)");
		expectSourceContains("src/settings.ts", "await createCustomApiHost(port).open(kind);");
		expectSourceNotContains("src/settings.ts", "Anthropic API Key");
		for (const obsoleteLabel of [
			"旧串行语音设置（存档）",
			"旧语音识别引擎",
			"旧本地断句（存档）",
			"旧·语音助手（存档）",
		]) expectSourceNotContains("src/settings.ts", obsoleteLabel);
	});

	it("reflows every remaining settings category into compact cards only when wide enough", () => {
		const workspaceCss = uiCss.slice(
			uiCss.indexOf("/* Settings configuration workspace · D-TLP-019")
		);
		expect(workspaceCss).toContain(
			"@container talos-app (min-width: 1240px)"
		);
		expect(workspaceCss).toContain(
			".talos-setcontent {"
		);
		expect(workspaceCss).toContain(
			"grid-template-columns: repeat(2, minmax(0, 1fr))"
		);
		expect(workspaceCss).toContain(
			"@container talos-app (max-width: 720px)"
		);
	});

	it("preserves themes, motion, secret storage, and automatic saves", () => {
		for (const theme of [
			"aurora",
			"cosmos-dark",
			"animal-island",
			"data-stream",
			"soft-relief",
			"geometric-modern",
			"executive-brief",
			"paper-ink",
		]) {
			expectSourceContains("src/settings.ts", `.addOption("${theme}"`);
		}
		expectSourceContains("src/settings.ts", "providerSecretStoreFromApp");
		expectSourceContains("src/settings.ts", "saveProviderSecret");
		expectSourceContains("src/settings.ts", "await this.plugin.saveTalosSettings()");
		expectSourceNotContains("styles.layout-overrides.css", "talos-embedded-workbench-settings");
		expectSourceContains("styles.layout-overrides.css", "animation: talos-app-content-in");
		expectSourceContains("styles.layout-overrides.css", "@media (prefers-reduced-motion: reduce)");
	});
});
