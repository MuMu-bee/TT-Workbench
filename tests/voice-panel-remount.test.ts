import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Q-ARC11：连续 mount 两次后第一轮资源被释放一次。
 *
 * 现状（改动前）：`mount()` 无条件重建 driver/tts/realtime/characterStage 却不先释放上一轮，
 * 而 mount 会被重复调用（Lens 的 railButton 对已激活的 voice 模块仍 navigate）。
 * 改动后 mount 开头有幂等释放：`if (this.mounted) { try { this.unmount(); } ... }`。
 */

const realtimeStop = vi.fn();
const driverDispose = vi.fn();
const ttsStop = vi.fn();
const stageDestroy = vi.fn();

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
		stop(): void {
			realtimeStop();
		}
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
		dispose(): void {
			driverDispose();
		}
		restoreVoiceHistory(): void {}
	},
}));

vi.mock("../src/jarvis/voiceio", () => ({
	StreamTts: class {
		stop(): void {
			ttsStop();
		}
		feed(): void {}
		flush(): void {}
	},
}));

vi.mock("../src/quyuan/voice-character-stage", () => ({
	QuyuanVoiceCharacterStage: class {
		setState(): void {}
		setInputLevel(): void {}
		setOutputLevel(): void {}
		destroy(): void {
			stageDestroy();
		}
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

function createPanel(): QuyuanVoicePanel {
	const settings = panelSettings() as unknown as TalosSettings;
	return new QuyuanVoicePanel(
		{} as App,
		{ manifest: { id: "tt-workbench" } } as never,
		settings,
		async () => undefined
	);
}

let env: ReturnType<typeof installPanelHostEnvironment>;

beforeEach(() => {
	realtimeStop.mockClear();
	driverDispose.mockClear();
	ttsStop.mockClear();
	stageDestroy.mockClear();
	env = installPanelHostEnvironment();
});

afterEach(() => {
	env.restore();
	vi.restoreAllMocks();
});

describe("voice panel re-mount teardown (Q-ARC11)", () => {
	it("releases the previous round exactly once when mount is called twice", () => {
		const panel = createPanel();

		panel.mount(env.host);
		// 首次 mount 不得误走释放路径（否则会白扔第一轮资源）。
		expect(realtimeStop).not.toHaveBeenCalled();
		expect(driverDispose).not.toHaveBeenCalled();
		expect(ttsStop).not.toHaveBeenCalled();
		expect(stageDestroy).not.toHaveBeenCalled();

		panel.mount(env.host);

		expect(realtimeStop).toHaveBeenCalledTimes(1);
		expect(driverDispose).toHaveBeenCalledTimes(1);
		expect(ttsStop).toHaveBeenCalledTimes(1);
		expect(stageDestroy).toHaveBeenCalledTimes(1);
	});
});
