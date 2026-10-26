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
import { createMiniHost, MiniElement } from "./helpers/mini-dom";

/** 为 MiniElement 补上 Obsidian 扩展方法(mini-dom 只模拟标准 DOM)。 */
function asObsidianElement(element: unknown): HTMLElement {
	const el = element as MiniElement & {
		empty?: () => void;
		createDiv?: (options?: { cls?: string; attr?: Record<string, string>; text?: string }) => unknown;
		createEl?: (tag: string, options?: { cls?: string; attr?: Record<string, string> }) => unknown;
		createSpan?: (options?: { text?: string }) => unknown;
		toggleClass?: (token: string, value?: boolean) => void;
	};
	el.empty = () => {
		el.children.length = 0;
	};
	el.createDiv = (options) => {
		const child = el.ownerDocument.createElement("div") as unknown as MiniElement & Record<string, unknown>;
		if (options?.cls) child.className = options.cls;
		if (options?.text) child.textContent = options.text;
		for (const [key, value] of Object.entries(options?.attr ?? {})) child.attributes.set(key, value);
		el.children.push(child);
		return asObsidianElement(child);
	};
	el.createEl = (tag, options) => {
		const child = el.ownerDocument.createElement(tag);
		if (options?.cls) child.className = options.cls;
		for (const [key, value] of Object.entries(options?.attr ?? {})) child.attributes.set(key, value);
		el.children.push(child);
		return asObsidianElement(child);
	};
	el.createSpan = (options) => el.createEl?.("span", { text: options?.text });
	el.toggleClass = (token, value) => {
		el.classList.toggle(token, value);
	};
	return el as unknown as HTMLElement;
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
		expect(hint).toContain("Realtime 端点");
		expect(hint).not.toContain("百炼");
		expect(
			voiceRealtimeSetupHint({
				quyuanRealtimeProviderKind: "openai-compatible",
				quyuanRealtimeEndpoint: "https://api.openai.com/v1/realtime",
			}),
		).toBe("");
		expect(
			voiceRealtimeLaunchHint({ quyuanRealtimeProviderKind: "openai-compatible" }),
		).toContain("自定义 Realtime 端点");
	});
});
