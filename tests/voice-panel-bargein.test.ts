import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Q-QUA14：打断（barge-in）。
 *
 * 现状（改动前）：`buildRealtime` 的 handlers 里有一段内联 onBargeIn，只把
 * `responseActive` 置 false 并把球体状态复位 700ms；真正含
 * `++responseGeneration / driver.cancel() / tts.stop()` 的 `private onBargeIn()`
 * 全仓零调用 → 用户开口打断时在途文字流不会被取消、朗读也不停。
 *
 * 这里的做法照方案第 4 步：不直接调私有方法（会挡类型检查），而是
 * ① `vi.mock` 掉 `qwen-realtime-voice`，让 `QwenRealtimeVoiceSession` 的构造函数
 *    把 handlers 存进测试可见变量；② mock 掉 driver / tts / 舞台，用 vi.fn 计次。
 */

const driverCancel = vi.fn();
const driverDispose = vi.fn();
const ttsStop = vi.fn();
const stageDestroy = vi.fn();
const realtimeStop = vi.fn();

/** 被 mock 的 QwenRealtimeVoiceSession 捕获到的 handlers。 */
type CapturedHandlers = { onBargeIn?: () => void };
let capturedHandlers: CapturedHandlers | null = null;

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
		constructor(_config: unknown, handlers: CapturedHandlers) {
			capturedHandlers = handlers;
		}
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
		cancel(): void {
			driverCancel();
		}
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

type PanelInternals = {
	buildRealtime(generation?: number): unknown;
	applyRealtimeState(state: "thinking" | "assistant-speaking"): void;
	goToChat(): void;
};

/**
 * 把面板推进到「助手正在回复」再返回 internals。
 *
 * 真实触发点是 qwen-realtime-voice.ts:743 的 `if (this.responseActive) this.handlers.onBargeIn?.()`，
 * 只在助手回复中触发；而 private onBargeIn() 自己还守着
 * `state === "think" || state === "speak" || driver?.isBusy()`（方案 Q-QUA14 步骤 1 要求原样保留）。
 * 因此测试必须先经 applyRealtimeState 进入 think 态，否则守卫会正确地拦掉这次调用。
 *
 * handlers 来自 mount() 内部那次 buildRealtime —— 那次带的 lifecycleGeneration
 * 就是当前代际，`current()` 因此为真；不要在这里再调一次（传错代际会让守卫拦掉）。
 */
function enterRespondingState(panel: QuyuanVoicePanel): PanelInternals {
	const internals = panel as unknown as PanelInternals;
	internals.applyRealtimeState("thinking");
	return internals;
}

function createPanel(navigate?: (pageKey: string) => void): QuyuanVoicePanel {
	const settings = panelSettings() as unknown as TalosSettings;
	return new QuyuanVoicePanel(
		{} as App,
		{ manifest: { id: "tt-workbench" } } as never,
		settings,
		async () => undefined,
		navigate
	);
}

let env: ReturnType<typeof installPanelHostEnvironment>;

beforeEach(() => {
	capturedHandlers = null;
	driverCancel.mockClear();
	driverDispose.mockClear();
	ttsStop.mockClear();
	stageDestroy.mockClear();
	realtimeStop.mockClear();
	env = installPanelHostEnvironment();
});

afterEach(() => {
	env.restore();
	vi.restoreAllMocks();
});

describe("voice panel barge-in (Q-QUA14)", () => {
	it("cancels the in-flight text stream and playback exactly once", () => {
		const panel = createPanel();
		// 面板必须先 mount：`current()` 要求 this.mounted 为真，否则守卫直接 return。
		panel.mount(env.host);
		enterRespondingState(panel);

		expect(capturedHandlers?.onBargeIn).toBeTypeOf("function");
		capturedHandlers?.onBargeIn?.();

		expect(driverCancel).toHaveBeenCalledTimes(1);
		expect(ttsStop).toHaveBeenCalledTimes(1);
		// 打断不应销毁舞台。
		expect(stageDestroy).not.toHaveBeenCalled();
	});

	it("keeps the generation guard: a stale lifecycle triggers no side effect", () => {
		const navigate = vi.fn();
		const panel = createPanel(navigate);
		panel.mount(env.host);
		const internals = enterRespondingState(panel);

		capturedHandlers?.onBargeIn?.();
		expect(driverCancel).toHaveBeenCalledTimes(1);
		expect(ttsStop).toHaveBeenCalledTimes(1);

		// goToChat 抬高 lifecycleGeneration（:551），使上面那个 handler 的 current() 变 false。
		// 注意 goToChat 自己也会 driver.cancel() / tts.stop()，所以这里比对的是
		// 「调用次数不变」而不是绝对值 1（方案写「仍为 1」时未计入 goToChat 自身的 cancel）。
		internals.goToChat();
		const driverCancelAfterGoToChat = driverCancel.mock.calls.length;
		const ttsStopAfterGoToChat = ttsStop.mock.calls.length;
		capturedHandlers?.onBargeIn?.();

		// 代际作废后 onBargeIn 的增量为 0（守卫仍生效）。
		expect(driverCancel).toHaveBeenCalledTimes(driverCancelAfterGoToChat);
		expect(ttsStop).toHaveBeenCalledTimes(ttsStopAfterGoToChat);
	});
});
