import { vi } from "vitest";
import { createObsidianHost, ObsidianTestElement } from "./obsidian-dom";

/**
 * 屈原语音面板的面板级测试骨架（Q-QUA14 / Q-ARC11 / Q-QUA15 共用）。
 *
 * `voice-panel.ts` 的依赖全部在模块作用域 import 进来，所以测试文件必须在
 * `vi.mock(...)` 之前不引入面板本身。这里只提供与具体 mock 无关的宿主环境：
 * - MiniElement 派生的 ObsidianTestElement（createDiv/createSpan/createEl/style/…）
 * - node 下缺失的 window / document / ResizeObserver / matchMedia / requestAnimationFrame
 *
 * 面板构造后挂到 `mount(host)` 时，真实 DOM 与 canvas 都不能跑，故测试文件里
 * 用 vi.mock 换掉 `voice-character-stage`、`talos-ball-view`、`native-voice-driver`、
 * `voiceio`、`qwen-realtime-voice`。本文件只管宿主。
 */

type FrameCallback = (time: number) => void;

export interface PanelHostEnvironment {
	host: HTMLElement;
	element: ObsidianTestElement;
	restore: () => void;
}

/**
 * 装一套 node 可用的窗口桩，并把 MiniDocument 暴露成 `document`。
 * 返回的 `restore()` 解掉全部全局 stub。
 */
export function installPanelHostEnvironment(): PanelHostEnvironment {
	const { host, element } = createObsidianHost();
	const frames = new Map<number, FrameCallback>();
	let nextFrame = 1;

	const fakeWindow = {
		setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms) as unknown as number,
		clearTimeout: (id?: number) => globalThis.clearTimeout(id),
		requestAnimationFrame: (callback: FrameCallback) => {
			const id = nextFrame++;
			frames.set(id, callback);
			return id;
		},
		cancelAnimationFrame: (id: number) => {
			frames.delete(id);
		},
		matchMedia: () => ({
			matches: false,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
		}),
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		speechSynthesis: { cancel: () => undefined },
	};

	// voice-panel 通过 element.ownerDocument.defaultView 拿窗口（readTalosBallTheme），
	// 故 MiniDocument 必须挂上 defaultView，否则 body.classList 处会抛。
	element.ownerDocument.defaultView = fakeWindow;

	const stubs: Array<[string, unknown]> = [
		["window", fakeWindow],
		["document", element.ownerDocument],
		["ResizeObserver", class {
			observe(): void {}
			disconnect(): void {}
		}],
		["navigator", { permissions: undefined }],
		["requestAnimationFrame", fakeWindow.requestAnimationFrame],
		["cancelAnimationFrame", fakeWindow.cancelAnimationFrame],
	];
	for (const [name, value] of stubs) vi.stubGlobal(name, value);

	return {
		host,
		element,
		restore: () => {
			frames.clear();
			element.ownerDocument.defaultView = null;
			vi.unstubAllGlobals();
		},
	};
}

/** 常用设置夹具：持续监听 + 已启用语音识别 + 百炼默认。 */
export function panelSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		quyuanVoiceInputMode: "continuous",
		quyuanVoiceRecognitionEnabled: true,
		quyuanRealtimeProviderKind: "dashscope",
		quyuanRealtimeModel: "qwen3.5-omni-flash-realtime",
		quyuanRealtimeVoice: "Tina",
		quyuanVoiceSessionJson: "",
		jarvisTabsJson: "",
		quyuanVoiceModel: "haiku",
		quyuanVoiceEffort: "low",
		voiceLang: "zh-CN",
		voicePersona: "",
		jarvisPermissionMode: "default",
		...overrides,
	};
}

/** 取私有字段（TS private 只在编译期生效）。 */
export function readPrivate<T>(target: unknown, key: string): T {
	return (target as Record<string, T>)[key];
}
