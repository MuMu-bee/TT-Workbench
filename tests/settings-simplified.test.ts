import { readFileSync } from "node:fs";
import { expectSourceContains, expectSourceNotContains } from "./helpers/source-text";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 设置页简化（2026-10-08）：合并重复内容，去掉无效与纯说明的设置项。
const root = fileURLToPath(new URL("../", import.meta.url));
const settings = readFileSync(`${root}src/settings.ts`, "utf8");

describe("simplified settings", () => {
	it("merges folder mapping and data sources into one library tab", () => {
		expectSourceContains("src/settings.ts", 'type TabId = "ui" | "library" | "channel" | "voice";');
		expectSourceNotContains("src/settings.ts", "renderSchema(");
		expectSourceNotContains("src/settings.ts", "renderData(");
		expectSourceContains("src/settings.ts", 'new Setting(c).setName("模块目录").setHeading();');
		expectSourceContains("src/settings.ts", 'new Setting(c).setName("统计来源文件").setHeading();');
	});

	it("derives the inbox and diary write folders from the module mapping instead of asking twice", () => {
		expectSourceNotContains("src/settings.ts", '"收件箱目录", "Inbox 计数 + 写入", "inboxFolder"');
		expectSourceNotContains("src/settings.ts", '"日记目录", "New Diary 写入", "dailyFolder"');
		expectSourceContains("src/settings.ts", "this.plugin.talosSettings.inboxFolder = schema.inbox;");
		expectSourceContains("src/settings.ts", "this.plugin.talosSettings.dailyFolder = schema.logs;");
		expect(settings.match(/this\.syncWriteFolders\(\);/g)?.length).toBeGreaterThanOrEqual(3);
	});

	it("drops settings without effect and headings without settings", () => {
		expectSourceNotContains("src/settings.ts", '"Eyebrow 小标题"');
		expectSourceNotContains("src/settings.ts", 'setName("权限").setHeading()');
		expectSourceNotContains("src/settings.ts", 'setName("OhMyPi").setHeading()');
		expectSourceNotContains("src/settings.ts", "隐私与计费：");
	});

	it("keeps every setting that still drives behaviour", () => {
		for (const key of [
			"mainTitle", "visualTheme", "syncVaultTheme", "openOnStartup", "welcomeEasterEgg", "talosPeerStatusBridgeEnabled",
			"tasksPath", "talosTasksPath", "pendingApprovalsPath", "candidatesPath", "healthLogPath", "reportsFolder", "freezeStartDate",
			"aliyunApiKey", "quyuanRealtimeWorkspaceId", "quyuanRealtimeRegion", "quyuanRealtimeModel", "quyuanRealtimeVoice",
			"quyuanVoiceModel", "quyuanVoiceEffort", "voicePersona", "voiceLang", "ttsVoice", "ttsRate", "ttsPitch",
		]) expect(settings, key).toContain(key);
	});
});
