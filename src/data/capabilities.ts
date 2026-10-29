import { App } from "obsidian";

export interface CapabilityItem {
	name: string; // 显示名，如 /morning 或 health-scanner
	invoke: string; // 点击复制的调用文本
	desc: string;
	path?: string;
}

export interface CapabilityGroup {
	key: string;
	label: string;
	meta: string;
	items: CapabilityItem[];
}

// 解析 md 文本的描述：优先 frontmatter description，其次首个 # 标题
function parseDesc(text: string): string {
	const fm = text.match(/^description:\s*["']?(.+?)["']?\s*$/m);
	if (fm && fm[1]) return fm[1].trim();
	const h = text.match(/^#\s+(.+)$/m);
	if (h && h[1]) {
		// "# /morning - 晨间简报与任务启动" → 取破折号后
		const parts = h[1].split(/\s*[-—]\s*/);
		return (parts.length > 1 ? parts.slice(1).join(" ") : h[1]).trim();
	}
	return "";
}

// 命令兜底描述（.claude/commands 读不到时用；与 CLAUDE.md 命令索引一致）
const COMMAND_FALLBACK: Record<string, string> = {
	morning: "晨间简报与任务启动",
	retrieval: "知识检索与主动关联",
	memory: "记忆三层模型与偏好管理",
	maintain: "回环检查、播种、健康扫描",
	intake: "收件箱智能归档",
	digest: "偏好候选池整理与晋升",
	create: "内容创作工作流",
	output: "输出统一处理器",
	"full-cycle": "一键全量归档+偏好消化+碎片保存",
	"weekly-reset": "周度系统重置",
	"mine-rules": "规则挖掘：从历史提炼操作规则",
	brand: "给 Kit/repo 打个人标签",
};

interface ListedFiles {
	files: string[];
	folders: string[];
}

async function safeList(app: App, path: string): Promise<ListedFiles | null> {
	try {
		const adapter = app.vault.adapter;
		if (!(await adapter.exists(path))) return null;
		return await adapter.list(path);
	} catch {
		return null;
	}
}

async function safeRead(app: App, path: string): Promise<string> {
	try {
		return await app.vault.adapter.read(path);
	} catch {
		return "";
	}
}

/** 第二段并发读的上限。Obsidian adapter 的并发行为未验证，8 是保守起点。 */
const CAPABILITY_READ_CONCURRENCY = 8;
/**
 * 能力文件短 TTL：与 main.ts 的 1500ms 文件变更 debounce 同量级，取 5s。
 * 代价是窗口内新建/改名的能力文件会暂时不可见；重命名后的旧键靠整表过期清理。
 */
const CAPABILITY_CACHE_TTL_MS = 5000;

const readCache = new Map<string, { at: number; text: string }>();

/**
 * 带 TTL 的 safeRead。**失败结果也进缓存**：SKILL.md 缺失时不必每次刷新都白读一遍。
 */
async function safeReadCached(app: App, path: string): Promise<string> {
	const cacheKey = path;
	const cached = readCache.get(cacheKey);
	const now = Date.now();
	if (cached && now - cached.at < CAPABILITY_CACHE_TTL_MS) return cached.text;
	const text = await safeRead(app, path);
	// 整表过期清理：重命名后旧键会残留，按 TTL 一次性扫掉。
	if (readCache.size > 256) {
		for (const [key, entry] of readCache) {
			if (now - entry.at >= CAPABILITY_CACHE_TTL_MS) readCache.delete(key);
		}
	}
	readCache.set(cacheKey, { at: now, text });
	return text;
}

/** 固定 limit 个 worker 从共享游标取任务；保持输出与入参同序。 */
async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
	const workers = Math.max(1, Math.min(limit, items.length));
	const run = async (): Promise<void> => {
		for (;;) {
			const index = cursor++;
			if (index >= items.length) return;
			results[index] = await fn(items[index], index);
		}
	};
	await Promise.all(Array.from({ length: workers }, run));
	return results;
}

function baseName(p: string): string {
	const n = p.split("/").pop() || p;
	return n.replace(/\.md$/, "");
}

/** 读任务表的一项：命令 / agent / workflow 是单文件，skill 带 README.md 兜底。 */
interface ReadJob {
	group: "commands" | "agents" | "skills" | "workflows";
	path: string;
	/** skill 专用：SKILL.md 读不到时再试 README.md。 */
	fallback?: string;
}

interface ReadResult {
	text: string;
	/** skill 专用：实际命中的候选路径（空串表示两者都没读到）。 */
	path: string;
}

export async function collectCapabilities(app: App): Promise<CapabilityGroup[]> {
	// ---- 第一段：只枚举目录，拼出一张平坦读任务表 ----
	const [cmdDir, agentDir, skillsDir, wfDir] = await Promise.all([
		safeList(app, ".claude/commands"),
		safeList(app, ".claude/agents"),
		safeList(app, ".agents/skills"),
		safeList(app, ".claude/workflows"),
	]);
	const mdFiles = (dir: ListedFiles | null): string[] =>
		dir ? dir.files.filter((x) => x.endsWith(".md")).sort() : [];

	const commandFiles = mdFiles(cmdDir);
	const agentFiles = mdFiles(agentDir);
	// skills 的每个文件夹变成「先试 SKILL.md，再试 README.md」一项。
	const skillFolders = (skillsDir?.folders ?? []).slice().sort();
	const workflowFiles = mdFiles(wfDir);

	const jobs: ReadJob[] = [
		...commandFiles.map((path): ReadJob => ({ group: "commands", path })),
		...agentFiles.map((path): ReadJob => ({ group: "agents", path })),
		...skillFolders.map(
			(folder): ReadJob => ({
				group: "skills",
				path: `${folder}/SKILL.md`,
				fallback: `${folder}/README.md`,
			})
		),
		...workflowFiles.map((path): ReadJob => ({ group: "workflows", path })),
	];

	// ---- 第二段：一张任务表、一次有界并发读 ----
	const results = await mapWithConcurrency(
		jobs,
		CAPABILITY_READ_CONCURRENCY,
		async (job): Promise<ReadResult> => {
			const text = await safeReadCached(app, job.path);
			if (text) return { text, path: job.path };
			if (!job.fallback) return { text: "", path: "" };
			const fallbackText = await safeReadCached(app, job.fallback);
			return fallbackText ? { text: fallbackText, path: job.fallback } : { text: "", path: "" };
		}
	);

	// 按组切回各自的读结果（顺序与组内文件顺序一致）。
	const textsOf = (group: ReadJob["group"]): ReadResult[] =>
		jobs.flatMap((job, index) =>
			job.group === group ? [results[index] ?? { text: "", path: "" }] : []
		);
	const commandTexts = textsOf("commands");
	const agentTexts = textsOf("agents");
	const skillTexts = textsOf("skills");
	const workflowTexts = textsOf("workflows");

	// ---- 组装：结构与顺序必须与改造前逐字一致 ----
	const cmdItems: CapabilityItem[] = commandFiles.map((f, index) => {
		const name = baseName(f);
		const desc = parseDesc(commandTexts[index]?.text ?? "") || COMMAND_FALLBACK[name] || "";
		return { name: `/${name}`, invoke: `/${name}`, desc, path: f };
	});
	if (cmdItems.length === 0) {
		for (const [name, desc] of Object.entries(COMMAND_FALLBACK)) {
			cmdItems.push({ name: `/${name}`, invoke: `/${name}`, desc });
		}
	}

	const agentItems: CapabilityItem[] = agentFiles.map((f, index) => {
		const name = baseName(f);
		return {
			name,
			invoke: name,
			desc: parseDesc(agentTexts[index]?.text ?? ""),
			path: f,
		};
	});
	for (const [index, folder] of skillFolders.entries()) {
		const resolved = skillTexts[index] ?? { text: "", path: "" };
		const name = baseName(folder);
		agentItems.push({
			name,
			invoke: name,
			desc: parseDesc(resolved.text) || "agent skill",
			path: resolved.path || undefined,
		});
	}

	const wfItems: CapabilityItem[] = workflowFiles.map((f, index) => {
		const name = baseName(f);
		return {
			name,
			invoke: name,
			desc: parseDesc(workflowTexts[index]?.text ?? ""),
			path: f,
		};
	});
	// workflow folder 派生项：只读目录名、不读文件，因此不进读任务表。
	if (wfDir) {
		for (const folder of wfDir.folders.slice().sort()) {
			wfItems.push({ name: baseName(folder), invoke: baseName(folder), desc: "工作流" });
		}
	}

	const groups: CapabilityGroup[] = [
		{ key: "commands", label: "命令", meta: "点击复制 · 在对话中调用", items: cmdItems },
		{ key: "agents", label: "Agents", meta: "子代理 / agent skills", items: agentItems },
	];
	if (wfItems.length > 0) {
		groups.push({ key: "workflows", label: "工作流", meta: ".claude/workflows", items: wfItems });
	}
	return groups;
}
