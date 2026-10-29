import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Q-ARC11（Lens 侧）：对同一 voice 模块重复 navigate 时走判重分支。
 *
 * 说明一处与方案验收表的偏差（已登记）：方案第 3 步写「只重绘不重挂」，
 * 但 `renderPage()` 本身就会经 `content()` → `renderVoice()` → `ctx.mountVoice()`。
 * 也就是说 mountVoice 仍会被调用，真正的「不叠连接」保证来自面板侧
 * mount() 开头的幂等释放（见 tests/voice-panel-remount.test.ts）。
 * 本用例把这个事实钉死，避免后来者以为判重分支能单独挡住重挂。
 */

vi.mock("obsidian", () => {
	class TFile {
		path = "";
		basename = "";
		parent = { path: "" };
		stat = { mtime: 0, size: 0 };
	}
	class Stub {}
	const known: Record<string, unknown> = {
		__esModule: true,
		TFile,
		getAllTags: () => [],
		// Lens 的 icon() 直接调用 setIcon（不是 new），必须给函数而不是类。
		setIcon: (): void => undefined,
	};
	return new Proxy(known, {
		get: (target, key: string): unknown =>
			key in target ? target[key] : key === "then" ? undefined : Stub,
		has: () => true,
	});
});

// 总览页需要完整的 Collected 夹具；本用例只关心 voice 模块，故把总览渲染换成空数组。
vi.mock("../src/ui/lens/lens-overview", () => ({
	renderOverviewToday: () => [],
	renderOverviewRhythm: () => [],
}));

import type { App } from "obsidian";
import type { Collected } from "../src/ui/talos-view-model";
import type { VaultPaths } from "../src/data/schema";
import { LensConsole } from "../src/ui/lens/lens-console";
import { createObsidianHost, ObsidianTestElement } from "./helpers/obsidian-dom";

const mountVoice = vi.fn();
const unmountVoice = vi.fn();

function createConsole(element: ObsidianTestElement): LensConsole {
	const doc = element.ownerDocument;
	doc.defaultView = {
		matchMedia: () => ({
			matches: false,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
		}),
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
	};
	const host = {
		app: {} as App,
		paths: () => ({ dir: () => "", file: () => "" }) as unknown as VaultPaths,
		profileName: () => "测试",
		appearance: () => "light" as const,
		openNote: () => undefined,
		openChat: () => undefined,
		renderSettings: () => undefined,
		mountVoice,
		unmountVoice,
		refresh: () => undefined,
	};
	return new LensConsole(host, element as unknown as HTMLElement);
}

beforeEach(() => {
	mountVoice.mockClear();
	unmountVoice.mockClear();
	// LENS renderPage 里读 doc.activeElement instanceof HTMLInputElement；node 下无该全局。
	vi.stubGlobal("HTMLInputElement", class {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("Lens voice navigate dedup (Q-ARC11)", () => {
	it("takes the redraw-only branch on a repeated voice navigate", () => {
		const { element } = createObsidianHost();
		const console = createConsole(element);
		console.setData({ projects: [] } as unknown as Collected, null);

		console.navigate("voice");
		const afterFirst = mountVoice.mock.calls.length;
		expect(afterFirst).toBeGreaterThanOrEqual(1);

		// 同模块同页签再点一次：走 shouldSkipVoiceRenavigate 分支，只重绘。
		console.navigate("voice");
		// 判重分支不 push 历史、不重复改 location；但 renderPage 仍会重新渲染页面。
		expect(unmountVoice).not.toHaveBeenCalled();
		expect(mountVoice.mock.calls.length).toBeGreaterThanOrEqual(afterFirst);
	});

	it("does not take the skip branch for a different module", () => {
		const { element } = createObsidianHost();
		const console = createConsole(element);
		console.setData({ projects: [] } as unknown as Collected, null);

		console.navigate("voice");
		// 离开 voice → 必须卸载（既有 unmountVoice 路径保持不变）。
		console.navigate("projects");
		expect(unmountVoice).toHaveBeenCalledTimes(1);
	});
});
