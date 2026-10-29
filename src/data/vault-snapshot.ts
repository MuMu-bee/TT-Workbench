import { App, TFile, normalizePath } from "obsidian";

/**
 * Q-PER1：一次刷新内的库文件快照。
 *
 * 报告的问题不是「遍历本身很慢」，而是**同一次 refresh 里 16 个采集器各自**
 * `getMarkdownFiles().filter(...)`——同一份文件列表被反复拿、反复过滤。
 * 这里把「拿列表」收成一次，并按目录前缀记忆化过滤结果。
 *
 * 两条硬约束（不要顺手改）：
 * 1. `notesUnder` 每次返回**浅拷贝**。navigation.ts 里多处对返回值原地 `.sort()`，
 *    若共享同一数组实例，前一个采集器的排序会污染后一个采集器的结果。
 * 2. 谓词逐字沿用改造前 stats.ts / navigation.ts 两处实现，不在此「统一口径」：
 *    只排除 EXCLUDE 与 `_README`；热力图（heatmapFiles）**不**排 `_README`，
 *    这是它与其他采集器口径不同的地方。
 */

// 计数排除：嵌套交付副本 / 依赖目录，不算知识笔记
const EXCLUDE = ["/node_modules/", "/客户交付物/", "/交付包/", "/talos-system-promo"];

function isExcluded(path: string): boolean {
	const sp = "/" + path;
	return EXCLUDE.some((x) => sp.includes(x));
}

export interface VaultSnapshot {
	/** 本轮刷新的全库 markdown 文件（与 getMarkdownFiles() 同一份顺序）。 */
	files: TFile[];
	/** 某目录下（不含 `_README`、不含交付副本）的 markdown 文件；每次返回浅拷贝。 */
	notesUnder(rel: string): TFile[];
	/** 基名 → 路径索引，供 resolveWiki 使用（同基名取第一个，与 Array.find 语义一致）。 */
	pathByBasename(name: string): string | undefined;
	/** 热力图口径：只排除 EXCLUDE，不排 `_README`。 */
	heatmapFiles(): TFile[];
}

export function createVaultSnapshot(app: App): VaultSnapshot {
	// 唯一一次全库取数：后续所有采集器共用这一份。
	const files = app.vault.getMarkdownFiles();
	const notesCache = new Map<string, TFile[]>();
	const basenameIndex = new Map<string, string>();
	for (const file of files) {
		if (!basenameIndex.has(file.basename)) basenameIndex.set(file.basename, file.path);
	}
	let heatmap: TFile[] | null = null;

	return {
		files,
		notesUnder(rel: string): TFile[] {
			const normalized = normalizePath(rel);
			const cached = notesCache.get(normalized);
			if (cached) return [...cached];
			const prefix = normalized + "/";
			const matched = files.filter(
				(f) =>
					(f.path === normalized || f.path.startsWith(prefix)) &&
					f.basename !== "_README" &&
					!isExcluded(f.path)
			);
			notesCache.set(normalized, matched);
			return [...matched];
		},
		pathByBasename(name: string): string | undefined {
			return basenameIndex.get(name);
		},
		heatmapFiles(): TFile[] {
			heatmap ??= files.filter((f) => !isExcluded(f.path));
			return heatmap;
		},
	};
}
