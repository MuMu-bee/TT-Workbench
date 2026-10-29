import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Q-ARC9（面板侧）：非 dashscope 端点缺转写模型时，持续监听下必须拒绝启动并给出含「转写」的提示，
 * push-to-talk 不受影响。
 *
 * 落点为什么在 `setVoiceRecognitionEnabled` 的初始化收尾处：`buildRealtime` 在 mount 早期
 * 就调用，那时 `rootEl`/`controlStatusEl`/`characterStage` 都还是 null，
 * `fallbackToPushToTalk` 里的 `renderVoiceRecognitionOff()` 与 `controlStatusEl?.setText`
 * 会全部命中 null、提示静默丢失，且该方法还必须返回 session。
 */

const fallbackCalls: string[] = [];

vi.mock("obsidian", () => ({
	App: class {},
	Component: class {
		load(): void {}
		unload(): void {}
	},
	MarkdownRenderer: { render: async () => undefined },
	Notice: class {
		constructor(_message?: string, _timeout?: number) {}
	},
	setIcon: (): void => undefined,
	requestUrl: vi.fn(),
}));

vi.mock("../src/quyuan/qwen-realtime-voice", () => ({
	QwenRealtimeVoiceSession: class {
		async start(): Promise<void> {}
		stop(): void {}
		// 必须在 start() 之后报已连接，否则会先命中「会话未能进入就绪状态」分支。
		isConnected(): boolean {
			return true;
		}
		setAwake(): void {}
		setInputEnabled(): void {}
		setOutputEnabled(): void {}
		cancelResponse(): void {}
	},
}));

vi.mock("../src/quyuan/native-voice-driver", () => ({
	QuyuanVoiceDriver: class {
		setConfirmHandler(): void {}
		isBusy(): boolean {
			return false;
		}
		cancel(): void {}
		dispose(): void {}
		restoreVoiceHistory(): void {}
	},
}));

vi.mock("../src/jarvis/voiceio", () => ({
	StreamTts: class {
		stop(): void {}
		feed(): void {}
		flush(): void {}
	},
}));

vi.mock("../src/quyuan/voice-character-stage", () => ({
	QuyuanVoiceCharacterStage: class {
		setState(): void {}
		setInputLevel(): void {}
		setOutputLevel(): void {}
		destroy(): void {}
	},
}));

vi.mock("../src/quyuan/talos-ball-view", () => ({
	TalosBallView: class {
		mount(): void {}
		updateState(): void {}
		updateTheme(): void {}
		destroy(): void {}
	},
}));

import type { App } from "obsidian";
import type { TalosSettings } from "../src/settings";
import { QuyuanVoicePanel } from "../src/quyuan/voice-panel";
import { installPanelHostEnvironment, panelSettings } from "./helpers/voice-panel-harness";

type PanelInternals = {
	setVoiceRecognitionEnabled(enabled: boolean, persist?: boolean): Promise<void>;
	fallbackToPushToTalk(reason: string): void;
	controlStatusEl: { textContent: string } | null;
};

function createPanel(settings: Record<string, unknown>): QuyuanVoicePanel {
	return new QuyuanVoicePanel(
		{} as App,
		{ manifest: { id: "tt-workbench" } } as never,
		settings as unknown as TalosSettings,
		async () => undefined
	);
}

let env: ReturnType<typeof installPanelHostEnvironment>;

beforeEach(() => {
	fallbackCalls.length = 0;
	env = installPanelHostEnvironment();
});

afterEach(() => {
	env.restore();
	vi.restoreAllMocks();
});

describe("continuous-listening refuses to start without a transcription model (Q-ARC9)", () => {
	it("falls back with a hint mentioning transcription in continuous mode", async () => {
		const panel = createPanel(panelSettings({
			quyuanRealtimeProviderKind: "openai-compatible",
			quyuanRealtimeEndpoint: "https://api.example.com/v1/realtime",
			quyuanRealtimeModel: "gpt-4o-realtime-preview",
			quyuanRealtimeTranscriptionModel: "",
			quyuanVoiceInputMode: "continuous",
		}));
		panel.mount(env.host);
		const internals = panel as unknown as PanelInternals;
		// 记录 fallbackToPushToTalk 的实参，同时保留真实实现（它会写 controlStatusEl）。
		const original = internals.fallbackToPushToTalk.bind(panel);
		internals.fallbackToPushToTalk = (reason: string): void => {
			fallbackCalls.push(reason);
			original(reason);
		};

		await internals.setVoiceRecognitionEnabled(true, false);

		expect(fallbackCalls).toHaveLength(1);
		expect(fallbackCalls[0]).toMatch(/转写/);
		// 提示真落到可见控件上（不是静默丢弃）。
		expect(internals.controlStatusEl?.textContent ?? "").toMatch(/转写/);
	});

	it("lets push-to-talk through even without a transcription model", async () => {
		const panel = createPanel(panelSettings({
			quyuanRealtimeProviderKind: "openai-compatible",
			quyuanRealtimeEndpoint: "https://api.example.com/v1/realtime",
			quyuanRealtimeModel: "gpt-4o-realtime-preview",
			quyuanRealtimeTranscriptionModel: "",
			quyuanVoiceInputMode: "push-to-talk",
		}));
		panel.mount(env.host);
		const internals = panel as unknown as PanelInternals;
		const original = internals.fallbackToPushToTalk.bind(panel);
		internals.fallbackToPushToTalk = (reason: string): void => {
			fallbackCalls.push(reason);
			original(reason);
		};

		await internals.setVoiceRecognitionEnabled(true, false);

		expect(fallbackCalls).toHaveLength(0);
	});

	it("does not refuse when the transcription model is configured", async () => {
		const panel = createPanel(panelSettings({
			quyuanRealtimeProviderKind: "openai-compatible",
			quyuanRealtimeEndpoint: "https://api.example.com/v1/realtime",
			quyuanRealtimeModel: "gpt-4o-realtime-preview",
			quyuanRealtimeTranscriptionModel: "x-asr",
			quyuanVoiceInputMode: "continuous",
		}));
		panel.mount(env.host);
		const internals = panel as unknown as PanelInternals;
		const original = internals.fallbackToPushToTalk.bind(panel);
		internals.fallbackToPushToTalk = (reason: string): void => {
			fallbackCalls.push(reason);
			original(reason);
		};

		await internals.setVoiceRecognitionEnabled(true, false);

		expect(fallbackCalls).toHaveLength(0);
	});
});
