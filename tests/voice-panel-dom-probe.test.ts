import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Q-ARC12 第 2 步：**拆分前先做 DOM 探针**。
 *
 * 方案要求先证明「`vi.mock("obsidian")` + 最小 App/plugin + `new QuyuanVoicePanel(...).mount(host)`
 * 能跑通」，再决定拆分后的验收形态；探针不通过时才走「强约束文本断言」的回退路径。
 *
 * 本用例就是那条探针，且刻意做成**最小**形态：只断言 mount 能跑完并产出面板根节点，
 * 不对任何具体 DOM 结构下断言（那会把拆分本身锁死）。它跑通即说明：
 *  - `voice-panel.ts` 对 `obsidian` 的硬依赖可以被 `vi.mock` 替身掉；
 *  - 面板可以在 node 环境里实例化并挂载，**不需要**真实 Obsidian/Electron；
 *  - 后续把 `mount()`（当前 196-503）拆成状态容器 + 子视图时，可以按行为断言验收，
 *    不必退回对源码文本做 `toContain`。
 *
 * 依赖的替身与 `tests/voice-panel-remount.test.ts` / `voice-panel-bargein.test.ts` 同一套；
 * 宿主环境来自 `tests/helpers/voice-panel-harness.ts`。
 */

vi.mock("obsidian", () => ({
	App: class {},
	Component: class {
		load(): void {}
		unload(): void {}
	},
	MarkdownRenderer: { render: async () => undefined },
	Modal: class {
		constructor(..._args: unknown[]) {}
		open(): void {}
		close(): void {}
	},
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
		isConnected(): boolean {
			return false;
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

let env: ReturnType<typeof installPanelHostEnvironment>;

beforeEach(() => {
	env = installPanelHostEnvironment();
});

afterEach(() => {
	env.restore();
	vi.restoreAllMocks();
});

describe("voice panel DOM probe (Q-ARC12 step 2)", () => {
	it("instantiates and mounts QuyuanVoicePanel in node with only the obsidian module mocked", () => {
		const settings = panelSettings() as unknown as TalosSettings;
		const panel = new QuyuanVoicePanel(
			{} as App,
			{ manifest: { id: "tt-workbench" } } as never,
			settings,
			async () => undefined
		);

		// 探针本体：不抛异常地跑完整个 mount()。
		expect(() => panel.mount(env.host)).not.toThrow();

		// 只断言「面板把自己的根节点挂上去了」——不断言内部结构，避免锁死拆分后的布局。
		expect(env.host.childElementCount).toBeGreaterThan(0);
		// 挂载后可卸载（unmount 不抛），保证拆分时生命周期仍可被单一入口收口。
		expect(() => panel.unmount()).not.toThrow();
	});
});
