import { describe, expect, it, vi } from "vitest";

// Q-QUA18：navigation.ts 顶层值导入 App/TFile/normalizePath，未 mock 时 import 期直接失败。
// 写法同 tests/data-vault-snapshot.test.ts:4-10。
vi.mock("obsidian", () => {
	class TFile {}
	class TFolder {}
	const normalizePath = (value: string): string =>
		value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	return { TFile, TFolder, normalizePath };
});

import { App, TFile, normalizePath } from "obsidian";
import { collectOutputCenter } from "../src/data/navigation";
import { SCHEMA_PRESET_CN, VaultPaths } from "../src/data/schema";

const paths = new VaultPaths(SCHEMA_PRESET_CN);
const NOW = Date.now();

interface NoteSpec {
	path: string;
	/** 缺省表示该笔记没有 frontmatter 块（getFileCache 返回的对象里没有 frontmatter）。 */
	frontmatter?: Record<string, unknown>;
}

function makeFile(spec: NoteSpec): TFile {
	const file = new TFile();
	const name = spec.path.split("/").pop() ?? spec.path;
	file.path = spec.path;
	file.basename = name.replace(/\.md$/, "");
	file.extension = "md";
	file.stat = { mtime: NOW, ctime: NOW, size: 0 };
	return file;
}

/** 合成 vault：只有 getMarkdownFiles / 路径查找 / frontmatter 缓存，够 collectOutputCenter 跑真路径。 */
function createHarness(notes: NoteSpec[]): App {
	const files = notes.map(makeFile);
	const byPath = new Map(files.map((file) => [file.path, file]));
	const frontmatterByPath = new Map(
		notes.map((note) => [normalizePath(note.path), note.frontmatter])
	);
	return {
		vault: {
			getMarkdownFiles: () => files,
			getAbstractFileByPath: (path: string) => byPath.get(normalizePath(path)) ?? null,
			cachedRead: async () => "",
			read: async () => "",
		},
		metadataCache: {
			getFileCache: (file: TFile) => {
				const frontmatter = frontmatterByPath.get(file.path);
				return frontmatter ? { frontmatter } : {};
			},
			resolvedLinks: {},
		},
	} as unknown as App;
}

describe("output platform classification", () => {
	it("counts notes without frontmatter as unclassified so the chart segment can be non-zero", async () => {
		const douyin = paths.outputPlatform("抖音");
		const app = createHarness([
			{ path: `${douyin}/已发布.md`, frontmatter: { status: "published" } },
			{ path: `${douyin}/裸笔记-1.md` },
			{ path: `${douyin}/裸笔记-2.md` },
		]);

		const center = await collectOutputCenter(app, paths);
		const platform = center.platforms[0];

		expect(platform).toMatchObject({ name: "抖音", count: 3, published: 1, pending: 0, unclassified: 2 });
		// 旧的残差式子（pending = count - published、unclassified = total - published - pending）
		// 在同一夹具下必然给 0：这正是报告里「图例与图段恒为 0」的口径错误。
		for (const item of center.platforms) {
			expect(item.published + item.pending + item.unclassified).toBe(item.count);
		}
	});

	it("treats a present-but-unpublished status as pending instead of unclassified", async () => {
		const douyin = paths.outputPlatform("抖音");
		const app = createHarness([
			{ path: `${douyin}/已发布.md`, frontmatter: { status: "published" } },
			{ path: `${douyin}/草稿.md`, frontmatter: { status: "draft" } },
			{ path: `${douyin}/裸笔记.md` },
		]);

		const [platform] = (await collectOutputCenter(app, paths)).platforms;
		expect(platform).toMatchObject({ count: 3, published: 1, pending: 1, unclassified: 1 });
	});

	it("reports 待闭环 from the pending bucket only, not from count - published", async () => {
		const douyin = paths.outputPlatform("抖音");
		const app = createHarness([
			{ path: `${douyin}/已发布.md`, frontmatter: { status: "published" } },
			{ path: `${douyin}/裸笔记-1.md` },
			{ path: `${douyin}/裸笔记-2.md` },
		]);

		const center = await collectOutputCenter(app, paths);
		const tile = center.metrics.find((metric) => metric.label === "平台稿件");
		expect(tile?.value).toBe("3");
		// 旧写法是 `${Math.max(0, total - published)} 待闭环`，同一夹具下会显示「2 待闭环」，
		// 而图里那 2 篇是未分类——同一页面自相矛盾。
		expect(tile?.sub).toBe("1 已发布 · 0 待闭环");
	});
});
