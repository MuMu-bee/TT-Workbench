import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_REALTIME_MODEL,
	DEFAULT_REALTIME_VOICE,
	restingVoiceState,
	voiceEngineAccessibleLabel,
	voiceEngineVisualLabel,
	voiceModelLabel,
	voicePermissionLabel,
	voiceTtsLabel,
	voiceRealtimeLaunchHint,
	voiceRealtimeSetupHint,
} from "../src/quyuan/voice-panel-labels";
import { confirmationQuestion, showVoiceConfirmCard } from "../src/quyuan/voice-confirm-card";
import { createMiniHost } from "./helpers/mini-dom";

/**
 * MiniElement 现在自带 Obsidian 的 HTMLElement 扩展（createDiv / createEl / createSpan /
 * setText / setCssProps / empty / toggleClass / style），见 tests/helpers/mini-dom.ts。
 * 原来这里那份 asObsidianElement 打补丁范式已无必要，且补丁返回值是 unknown，
 * 会拖累 tsc；改为直接断言宿主类型。
 */
function asObsidianElement(element: unknown): HTMLElement {
	return element as HTMLElement;
}

describe("voice panel labels", () => {
	it("falls back to defaults when realtime settings are empty", () => {
		expect(voiceModelLabel({})).toBe(DEFAULT_REALTIME_MODEL);
		expect(voiceModelLabel({ quyuanRealtimeModel: "  " })).toBe(DEFAULT_REALTIME_MODEL);
		expect(voiceTtsLabel({})).toBe(`千问 Realtime · ${DEFAULT_REALTIME_VOICE}`);
	});

	it("uses configured values when present", () => {
		expect(voiceModelLabel({ quyuanRealtimeModel: "qwen3.5-omni-plus-realtime" }))
			.toBe("qwen3.5-omni-plus-realtime");
		expect(voiceTtsLabel({ quyuanRealtimeVoice: "Ethan" })).toBe("千问 Realtime · Ethan");
	});

	it("describes the engine accessible label per realtime provider kind", () => {
		expect(voiceEngineAccessibleLabel({})).toContain("百炼 Qwen Omni Realtime");
		expect(voiceEngineAccessibleLabel({ quyuanRealtimeProviderKind: "openai-compatible" }))
			.toContain("自定义 OpenAI 兼容 Realtime");
		expect(voiceEngineVisualLabel()).toBe("云端实时");
	});

	it("keeps the voice permission label available for every chat permission setting", () => {
		for (const mode of ["default", "bypassPermissions", "plan", "acceptEdits"]) {
			const label = voicePermissionLabel({ jarvisPermissionMode: mode });
			expect(typeof label).toBe("string");
			expect(label.length).toBeGreaterThan(0);
		}
	});

	it("derives resting state from connection and wake flags", () => {
		expect(restingVoiceState({ connected: false, wakeActive: true })).toBe("idle");
		expect(restingVoiceState({ connected: true, wakeActive: false })).toBe("sleep");
		expect(restingVoiceState({ connected: true, wakeActive: true })).toBe("listen");
	});
});

describe("voice confirm card", () => {
	beforeEach(() => {
		vi.stubGlobal("window", { setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms), clearTimeout: (id?: number) => clearTimeout(id) });
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("builds the question text from the described action", () => {
		expect(confirmationQuestion("归档三条笔记")).toBe("需要确认：屈原想执行「归档三条笔记」。确认吗？");
	});

	it("resolves false on timeout without user input", async () => {
		{
			const { host } = createMiniHost();
			const promise = showVoiceConfirmCard({
				host: asObsidianElement(host),
				toolName: "Write",
				description: "写入一条笔记",
				speak: false,
				timeoutMs: 20,
			});
			await expect(promise).resolves.toBe(false);
		}
	});

	it("speaks the prompt only when speech is enabled", async () => {
		{
			const feedSpeech = vi.fn();
			const { host } = createMiniHost();
			const promise = showVoiceConfirmCard({
				host: asObsidianElement(host),
				toolName: "Bash",
				description: "执行命令",
				speak: true,
				feedSpeech,
				timeoutMs: 20,
			});
			expect(feedSpeech).toHaveBeenCalledOnce();
			expect(feedSpeech.mock.calls[0]?.[0]).toContain("执行命令");
			await expect(promise).resolves.toBe(false);
		}
	});

	it("stays silent when speech is disabled", async () => {
		{
			const feedSpeech = vi.fn();
			const { host } = createMiniHost();
			const promise = showVoiceConfirmCard({
				host: asObsidianElement(host),
				toolName: "Write",
				description: "写入",
				speak: false,
				feedSpeech,
				timeoutMs: 20,
			});
			expect(feedSpeech).not.toHaveBeenCalled();
			await expect(promise).resolves.toBe(false);
		}
	});
});

describe("provider-aware voice hints", () => {
	it("points Bailian users at workspace id and key", () => {
		expect(voiceRealtimeSetupHint({})).toContain("百炼业务空间 ID");
		expect(voiceRealtimeSetupHint({ quyuanRealtimeWorkspaceId: "ws-1" })).toBe("");
		expect(voiceRealtimeLaunchHint({})).toContain("百炼实时语音");
	});

	it("points OpenAI-compatible users at endpoint and key ref, never Bailian", () => {
		const hint = voiceRealtimeSetupHint({ quyuanRealtimeProviderKind: "openai-compatible" });
		expect(hint.includes("Realtime 端点")).toBe(true);
		expect(hint.includes("百炼")).toBe(false);
		// Q-ARC9：端点已填但转写模型为空 → 含「转写」的提示（否则持续监听下唤醒词静默失效）；
		// 端点与转写模型都填好才返回空串。
		expect(
			voiceRealtimeSetupHint({
				quyuanRealtimeProviderKind: "openai-compatible",
				quyuanRealtimeEndpoint: "https://api.openai.com/v1/realtime",
			}).includes("转写"),
		).toBe(true);
		expect(
			voiceRealtimeSetupHint({
				quyuanRealtimeProviderKind: "openai-compatible",
				quyuanRealtimeEndpoint: "https://api.openai.com/v1/realtime",
				quyuanRealtimeTranscriptionModel: "x-asr",
			}),
		).toBe("");
		expect(
			voiceRealtimeLaunchHint({ quyuanRealtimeProviderKind: "openai-compatible" }).includes("自定义 Realtime 端点"),
		).toBe(true);
	});
});
