import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Q-QUA15：`navigatingToChat` 的 TTL。
 *
 * 现状（改动前）：标志只在 `goToChat` 置 true、只在 `mount`/`unmount` 复位，
 * 而 `goToChat` 走 `navigateToPage("chat")` 后本面板从不 unmount
 * （`view.ts` 在 `renderedPage === activePage` 处早退；`lens-console.ts` 对
 * assistant 模块直接 `host.openChat(); return`）→ 标志永久为 true，
 * `:798/821/1155/1264/1273` 的守卫静默吞掉全部转写与回复。
 *
 * 本条只验「标志会复位」，**不**验「转写随之恢复」：`goToChat` 抬高的
 * `lifecycleGeneration` 已让 `buildRealtime` 的 `current()` 永久为 false，
 * 端到端恢复依赖重新 mount（Q-ARC11 的范围）。
 */

const driverCancel = vi.fn();
const ttsStop = vi.fn();

type PanelInternals = {
	goToChat(): void;
	markNavigatingToChat(ttlMs?: number): void;
	clearNavigatingToChat(): void;
	navigatingToChat: boolean;
	navigatingToChatTimer: number | null;
};

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
		dispose(): void {}
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

function internalsOf(panel: QuyuanVoicePanel): PanelInternals {
	return panel as unknown as PanelInternals;
}

let env: ReturnType<typeof installPanelHostEnvironment>;

beforeEach(() => {
	driverCancel.mockClear();
	ttsStop.mockClear();
	vi.useFakeTimers();
	env = installPanelHostEnvironment();
});

afterEach(() => {
	env.restore();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("voice panel navigatingToChat TTL (Q-QUA15)", () => {
	it("resets the flag within the TTL even when the panel is never unmounted", () => {
		const panel = createPanel(vi.fn());
		panel.mount(env.host);

		internalsOf(panel).goToChat();
		expect(internalsOf(panel).navigatingToChat).toBe(true);

		// 不调 unmount —— 这正是 report 指出的真实路径（goToChat 之后面板从不卸载）。
		vi.advanceTimersByTime(500);
		expect(internalsOf(panel).navigatingToChat).toBe(false);
	});

	it("clears the timer on unmount so no late write survives", () => {
		const panel = createPanel(vi.fn());
		panel.mount(env.host);
		internalsOf(panel).goToChat();
		expect(internalsOf(panel).navigatingToChatTimer).not.toBeNull();

		panel.unmount();
		expect(internalsOf(panel).navigatingToChatTimer).toBeNull();
		expect(internalsOf(panel).navigatingToChat).toBe(false);

		// unmount 之后推进 1000ms 不应抛错，标志保持 false。
		expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
		expect(internalsOf(panel).navigatingToChat).toBe(false);
	});
});
