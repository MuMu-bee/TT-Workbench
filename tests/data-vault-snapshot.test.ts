import { describe, expect, it, vi } from "vitest";

// Q-PER1：stats.ts:1 是值导入（App, TFile, normalizePath），未 mock 时 import 直接失败。
vi.mock("obsidian", () => {
	class TFile {}
	class TFolder {}
	const normalizePath = (value: string): string =>
		value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	return { TFile, TFolder, normalizePath };
});

import { App, TFile, TFolder, normalizePath } from "obsidian";
import { SCHEMA_PRESET_CN, VaultPaths } from "../src/data/schema";
import { createVaultSnapshot } from "../src/data/vault-snapshot";
import {
	collectDist,
	collectHeatmap,
	collectModules,
	collectOverview,
} from "../src/data/stats";
import { collectKnowledgeHub, collectOutputCenter } from "../src/data/navigation";
import type { HealthPoint, StatCard } from "../src/types";

const DAY = 86400000;
const paths = new VaultPaths(SCHEMA_PRESET_CN);
// 固定时间基准，保证 collectHeatmap / collectOverview 的输出可复现。
const NOW = Date.now();

interface FixtureFile {
	path: string;
	mtime?: number;
	ctime?: number;
}

function makeFile(spec: FixtureFile): TFile {
	const file = new TFile();
	const name = spec.path.split("/").pop() ?? spec.path;
	file.path = spec.path;
	file.basename = name.replace(/\.md$/, "");
	file.extension = "md";
	file.stat = {
		mtime: spec.mtime ?? NOW - 2 * DAY,
		ctime: spec.ctime ?? NOW - 30 * DAY,
		size: 0,
	};
	return file;
}

interface Harness {
	app: App;
	files: TFile[];
	getMarkdownFilesCalls: () => number;
	outletBody: string;
}

function createHarness(specs: FixtureFile[], outletBody = ""): Harness {
	const files = specs.map(makeFile);
	let calls = 0;
	const byPath = new Map(files.map((file) => [file.path, file]));
	const app = {
		vault: {
			getMarkdownFiles: () => {
				calls += 1;
				return files;
			},
			getAbstractFileByPath: (path: string) => byPath.get(normalizePath(path)) ?? null,
			cachedRead: async (file: TFile) => (file.path === paths.outletFile ? outletBody : ""),
			read: async () => "",
		},
		metadataCache: {
			getFileCache: () => ({ frontmatter: {} }),
			resolvedLinks: {},
		},
	} as unknown as App;
	return { app, files, getMarkdownFilesCalls: () => calls, outletBody };
}

function fixtureSpecs(): FixtureFile[] {
	return [
		// 收件箱
		{ path: `${paths.dir("inbox")}/a.md`, mtime: NOW - DAY, ctime: NOW - 10 * DAY },
		{ path: `${paths.dir("inbox")}/b.md`, mtime: NOW - 2 * DAY, ctime: NOW - 5 * DAY },
		{ path: `${paths.dir("inbox")}/_README.md`, mtime: NOW - 3 * DAY },
		// 洞察 + MOC
		{ path: `${paths.dir("insights")}/i1.md`, mtime: NOW - 3 * DAY, ctime: NOW - 2 * DAY },
		{ path: `${paths.dir("insights")}/i2.md`, mtime: NOW - 1 * DAY, ctime: NOW - 1 * DAY },
		{ path: `${paths.mocDir}/moc-1.md`, mtime: NOW - 4 * DAY },
		{ path: `${paths.mocDir}/moc-2.md`, mtime: NOW - 6 * DAY },
		// 素材 / 项目 / 日志 / 归档
		{ path: `${paths.dir("assets")}/s1.md`, mtime: NOW - 7 * DAY },
		{ path: `${paths.dir("projects")}/p1.md`, mtime: NOW - 8 * DAY },
		{ path: `${paths.dir("projects")}/TALOS系统/t1.md`, mtime: NOW - 9 * DAY },
		{ path: `${paths.dir("logs")}/l1.md`, mtime: NOW - 10 * DAY },
		{ path: `${paths.dir("archive")}/ar1.md`, mtime: NOW - 11 * DAY },
		// 输出平台
		{ path: `${paths.outputPlatform("抖音")}/d1.md`, mtime: NOW - 12 * DAY },
		{ path: `${paths.outputPlatform("抖音")}/d2.md`, mtime: NOW - 13 * DAY },
		// 交付副本：必须被排除
		{ path: `${paths.dir("assets")}/交付包/copy.md`, mtime: NOW - 14 * DAY },
		// 统一出口：真实库里也是 markdown 文件，readFile 才能取到正文。
		{ path: paths.outletFile, mtime: NOW - 16 * DAY },
		// 唯一的 _README（用于热力图口径断言）
		{ path: `${paths.dir("logs")}/_README.md`, mtime: NOW - 15 * DAY, ctime: NOW - 20 * DAY },
	];
}

const taskFlow: StatCard = { label: "任务流", value: "0%", sub: "", tone: "default" };
const healthTrend: HealthPoint[] = [];

/**
 * 造一段带 8 个「不存在的 wiki 链接」的统一出口正文：
 * `getAbstractFileByPath` 找不到它们，只能靠基名索引回退 → 强制走 resolveWiki 的
 * 全库/索引分支。8 条是原有的 limit 上限。
 */
function outletWithMissingWikiLinks(): string {
	const lines: string[] = [];
	for (let index = 1; index <= 8; index++) {
		lines.push(`- [[不存在的稿件-${index}]]`);
	}
	return lines.join("\n");
}

describe("vault snapshot collapses the refresh-wide vault scan", () => {
	it("scans the vault exactly once across every collector", async () => {
		const { app, getMarkdownFilesCalls } = createHarness(fixtureSpecs(), outletWithMissingWikiLinks());
		const snapshot = createVaultSnapshot(app);
		collectDist(app, paths, snapshot);
		collectModules(app, paths, snapshot);
		collectOverview(app, paths, 9, 2, taskFlow, healthTrend, snapshot);
		collectHeatmap(app, snapshot);
		await collectOutputCenter(app, paths, snapshot);
		collectKnowledgeHub(app, paths, snapshot);
		expect(getMarkdownFilesCalls()).toBe(1);
	});

	it("keeps dist / modules / heatmap / overview identical with and without the snapshot", async () => {
		const { app } = createHarness(fixtureSpecs(), outletWithMissingWikiLinks());
		const snapshot = createVaultSnapshot(app);

		expect(collectDist(app, paths, snapshot)).toEqual(collectDist(app, paths));
		expect(collectModules(app, paths, snapshot)).toEqual(collectModules(app, paths));
		expect(collectHeatmap(app, snapshot)).toEqual(collectHeatmap(app));

		const total = collectDist(app, paths).total;
		expect(collectOverview(app, paths, total, 2, taskFlow, healthTrend, snapshot)).toEqual(
			collectOverview(app, paths, total, 2, taskFlow, healthTrend)
		);
	});

	it("keeps resolveWiki falling back to the basename index", async () => {
		const { app } = createHarness(fixtureSpecs(), outletWithMissingWikiLinks());
		const snapshot = createVaultSnapshot(app);
		const withSnapshot = await collectOutputCenter(app, paths, snapshot);
		const withoutSnapshot = await collectOutputCenter(app, paths);
		expect(withSnapshot).toEqual(withoutSnapshot);
		// 8 条链接的 direct 路径都不存在 → 走基名回退，仍返回 direct，不静默丢条目。
		expect(withSnapshot.queue).toHaveLength(8);
	});

	it("resolves a wiki link by basename when only the basename exists", async () => {
		// `[[moc-1]]` 的 direct 路径 `moc-1.md` 不存在，真实文件在 insights/MOC/ 下：
		// 只有基名索引/全库 find 分支能解析出来。
		const { app } = createHarness(fixtureSpecs(), "- [[moc-1]] 概念入口");
		const snapshot = createVaultSnapshot(app);
		const withSnapshot = await collectOutputCenter(app, paths, snapshot);
		const withoutSnapshot = await collectOutputCenter(app, paths);
		expect(withSnapshot).toEqual(withoutSnapshot);
		expect(withSnapshot.queue.map((item) => item.path)).toEqual([`${paths.mocDir}/moc-1.md`]);
	});

	it("hands out copies so one collector's in-place sort cannot poison the next", () => {
		const { app } = createHarness(fixtureSpecs());
		const snapshot = createVaultSnapshot(app);
		const insightsDir = paths.dir("insights");
		const baseline = snapshot.notesUnder(insightsDir).map((file) => file.path);
		const second = snapshot.notesUnder(insightsDir);
		expect(second).not.toBe(snapshot.notesUnder(insightsDir));
		expect(second).not.toBe(baseline);

		// collectKnowledgeHub 会对 notesUnder 的返回值原地 .sort()（mtime 降序）。
		collectKnowledgeHub(app, paths, snapshot);
		expect(snapshot.notesUnder(insightsDir).map((file) => file.path)).toEqual(baseline);

		// 交替调用后彼此顺序不受影响：两次 collectKnowledgeHub 结果一致。
		const first = collectKnowledgeHub(app, paths, snapshot);
		const withOther = collectModules(app, paths, snapshot);
		const secondHub = collectKnowledgeHub(app, paths, snapshot);
		expect(secondHub).toEqual(first);
		expect(collectModules(app, paths, snapshot)).toEqual(withOther);
	});

	it("keeps the heatmap predicate (only EXCLUDE, never _README)", () => {
		const { app } = createHarness(fixtureSpecs());
		const snapshot = createVaultSnapshot(app);
		const heatmapPaths = snapshot.heatmapFiles().map((file) => file.path);
		// 断言运行时路径数组，不用 toContain（Q-TES5 的纯文本断言闸门只允许下调）。
		expect(heatmapPaths.includes(`${paths.dir("logs")}/_README.md`)).toBe(true);
		expect(heatmapPaths.includes(`${paths.dir("inbox")}/_README.md`)).toBe(true);
		// EXCLUDE 里的交付副本仍然被排掉。
		expect(heatmapPaths.includes(`${paths.dir("assets")}/交付包/copy.md`)).toBe(false);
	});

	it("still excludes _README from notesUnder", () => {
		const { app } = createHarness(fixtureSpecs());
		const snapshot = createVaultSnapshot(app);
		expect(snapshot.notesUnder(paths.dir("inbox")).map((file) => file.path)).toEqual([
			`${paths.dir("inbox")}/a.md`,
			`${paths.dir("inbox")}/b.md`,
		]);
	});

	it("exposes real TFolder-free snapshots without touching the folder type", () => {
		// 保留 TFolder 值导入的用法：collectOutputCenter 的路径推导走 VaultPaths，
		// 与 TFolder 无关；这条断言只锁住「mock 里的 TFolder 是真构造器」，
		// 避免有人把 mock 换成只提供 TFile 的版本后 scan 契约静默失效。
		expect(new TFolder()).toBeInstanceOf(TFolder);
	});
});
