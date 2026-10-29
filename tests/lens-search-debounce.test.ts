import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Q-PER9：必须显式 mock 这三个。只 mock setIcon 不够——lens-data.ts 的 listNotes 会调
// getAllTags（漏 mock 时报 `No "getAllTags" export is defined on the "obsidian" mock`）。
vi.mock("obsidian", () => ({
	setIcon: vi.fn(),
	getAllTags: (cache: { tags?: Array<{ tag: string }> } | null) =>
		cache?.tags ? cache.tags.map((tag) => tag.tag) : null,
	TFile: class {},
}));

// 总览页要完整 Collected 夹具；本用例不关心它，换成空数组（照 tests/lens-voice-remount.test.ts:34）。
vi.mock("../src/ui/lens/lens-overview", () => ({
	renderOverviewToday: () => [],
	renderOverviewRhythm: () => [],
}));

import type { App } from "obsidian";
import type { VaultPaths } from "../src/data/schema";
import type { Collected } from "../src/ui/talos-view-model";
import { debounce, type Debounced } from "../src/ui/lens/lens-dom";
import { listNotes, type LensData } from "../src/ui/lens/lens-data";
import { noteDeck } from "../src/ui/lens/lens-library";
import { LensConsole } from "../src/ui/lens/lens-console";
import type { LensContext, LensState } from "../src/ui/lens/lens-pages";
import { createMiniHost } from "./helpers/mini-dom";
import { createObsidianHost } from "./helpers/obsidian-dom";

const root = fileURLToPath(new URL("../", import.meta.url));
const consoleSource = readFileSync(`${root}src/ui/lens/lens-console.ts`, "utf8");

/** 从源码里取出防抖窗口，让「窗口落在 200-250ms」与真实使用的值绑在一起。 */
function searchDebounceMs(): number {
	const match = consoleSource.match(/const SEARCH_DEBOUNCE_MS = (\d+);/);
	if (!match) throw new Error("lens-console.ts 里找不到 SEARCH_DEBOUNCE_MS 常量");
	return Number(match[1]);
}

interface FakeFile {
	path: string;
	basename: string;
	parent: { path: string };
	stat: { mtime: number; size: number };
}

function fakeFile(path: string): FakeFile {
	const cut = path.lastIndexOf("/");
	return {
		path,
		basename: path.slice(cut + 1).replace(/\.md$/, ""),
		parent: { path: path.slice(0, cut) },
		stat: { mtime: 1_700_000_000_000, size: 128 },
	};
}

/**
 * 假 ctx：node 下没有 window / HTMLInputElement，碰 LensConsole.renderPage 会直接抛，
 * 所以这里只造 noteDeck 真正读到的成员（方案第 7 步前置①）。
 * `rerenderDebounced` 不在这里走真防抖——防抖本身由下面的 debounce 用例单独测，
 * 这里只把「重建一次」记到 renders 上，方便断言「5 个字符只重建 1 次」。
 */
function createFakeContext(options: { generation: number; render: () => void }): {
	ctx: LensContext;
	vaultReads: () => number;
} {
	const files = [
		fakeFile("02-洞察/a.md"),
		fakeFile("02-洞察/b.md"),
		fakeFile("02-洞察/_README.md"),
		fakeFile("03-素材/s1.md"),
		fakeFile("03-素材/s2.md"),
	];
	let reads = 0;
	const app = {
		vault: {
			getMarkdownFiles: () => {
				reads += 1;
				return files;
			},
			getAbstractFileByPath: () => null,
		},
		metadataCache: {
			getFileCache: (file: FakeFile) => ({ tags: [{ tag: `#${file.basename}` }] }),
		},
	};
	const { element } = createMiniHost();
	const state: LensState = { projectView: "board", projectFilter: "all", queries: {}, deckPages: {}, ovExpand: null };
	const ctx: LensContext = {
		doc: element.ownerDocument as unknown as Document,
		app: app as unknown as App,
		data: { collected: {} as Collected, capturedAt: options.generation } as LensData,
		paths: {} as VaultPaths,
		profileName: "测试",
		state,
		tab: null,
		navigate: () => undefined,
		rerender: () => undefined,
		rerenderDebounced: () => options.render(),
		flushRerender: () => undefined,
		openNote: () => undefined,
		openDrawer: () => undefined,
		drawerPath: () => null,
		openChat: () => undefined,
		renderSettings: () => undefined,
		mountVoice: () => undefined,
		refresh: () => undefined,
	};
	return { ctx, vaultReads: () => reads };
}

/** 真实 LensConsole：构造期只画外壳和空态，不碰 renderPage 的输入框分支。 */
function createConsole(): LensConsole {
	const { element } = createObsidianHost();
	const host = {
		app: {} as App,
		paths: () => ({ dir: () => "", file: () => "" }) as unknown as VaultPaths,
		profileName: () => "测试",
		appearance: () => "light" as const,
		openNote: () => undefined,
		openChat: () => undefined,
		renderSettings: () => undefined,
		mountVoice: () => undefined,
		unmountVoice: () => undefined,
		refresh: () => undefined,
	};
	return new LensConsole(host, element as unknown as HTMLElement);
}

beforeEach(() => {
	// renderPage 首行读 doc.activeElement instanceof HTMLInputElement；node 下无该全局。
	vi.stubGlobal("HTMLInputElement", class {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("Lens search debounce and note cache (Q-PER9)", () => {
	it("collapses five keystrokes into a single rebuild", () => {
		vi.useFakeTimers();
		const wait = searchDebounceMs();
		let renders = 0;
		let ctx: LensContext = null as unknown as LensContext;
		const { ctx: fake } = createFakeContext({
			generation: 1000,
			// 计数之外真的再渲染一次 noteDeck：断言不只是在数自己的闭包。
			render: () => {
				renders += 1;
				noteDeck(ctx, "collect", "收件", "02-洞察");
			},
		});
		ctx = fake;

		// 模拟 searchBox 的 input 处理器：状态写完后调 rerenderDebounced()。
		const rerenderDebounced: Debounced = debounce(() => ctx.rerenderDebounced(), wait);
		for (let index = 0; index < 5; index++) {
			rerenderDebounced.run();
			vi.advanceTimersByTime(20);
		}
		expect(renders).toBe(0);
		vi.advanceTimersByTime(wait);
		expect(renders).toBe(1);

		// 最后一个字符之后再敲一下：窗口重新计时，仍然是「窗口结束才渲染一次」。
		rerenderDebounced.run();
		vi.advanceTimersByTime(wait - 1);
		expect(renders).toBe(1);
		vi.advanceTimersByTime(1);
		expect(renders).toBe(2);
	});

	it("reads the vault once per capturedAt generation, twice without a generation key", () => {
		const folder = "03-素材";
		const generation = 424242;
		const { ctx, vaultReads } = createFakeContext({ generation, render: () => undefined });

		// 第一次渲染读一次库。
		expect(listNotes(ctx.app, folder, { skipReadme: true, generation: ctx.data.capturedAt })).toHaveLength(2);
		expect(vaultReads()).toBe(1);
		// 同一代际内的重建命中缓存：屏幕上的渲染次数不变，库读取也不增。
		noteDeck(ctx, "materials", "素材", folder);
		expect(vaultReads()).toBe(1);

		// 对照组：不传 generation（无缓存）时同一目录读两次库 —— 证明上面那条能区分有无缓存。
		expect(listNotes(ctx.app, folder, { skipReadme: true })).toHaveLength(2);
		expect(listNotes(ctx.app, folder, { skipReadme: true })).toHaveLength(2);
		expect(vaultReads()).toBe(3);

		// 换代际（新的 capturedAt）后缓存失效，重新读库。
		ctx.data = { ...ctx.data, capturedAt: generation + 1 };
		noteDeck(ctx, "materials", "素材", folder);
		expect(vaultReads()).toBe(4);
	});

	it("keeps the debounce window in the 200-250ms range and drops pending rebuilds after dispose", () => {
		const wait = searchDebounceMs();
		expect(wait).toBeGreaterThanOrEqual(200);
		expect(wait).toBeLessThanOrEqual(250);

		vi.useFakeTimers();
		const lens = createConsole();
		// dispose 之前把 renderPage 换成 spy：真触发才会计数，未触发则不会走到会抛错的真实实现。
		const renderPage = vi.spyOn(lens, "renderPage").mockImplementation(() => undefined);
		const debounced = (lens as unknown as { rerenderDebounced: Debounced }).rerenderDebounced;

		debounced.run();
		expect(renderPage).not.toHaveBeenCalled();

		lens.dispose();
		vi.advanceTimersByTime(500);
		// dispose() 在 root.remove() 之前 cancel：待处理的重绘必须被丢掉，增量 = 0。
		expect(renderPage).not.toHaveBeenCalled();
	});
});
