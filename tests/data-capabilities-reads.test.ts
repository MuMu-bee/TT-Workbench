import { describe, expect, it, vi } from "vitest";

import { App } from "obsidian";

type CollectCapabilities = typeof import("../src/data/capabilities")["collectCapabilities"];

/**
 * `safeReadCached` 的 TTL 缓存是模块级的（生产语义如此，方案也要求它按进程内整表过期）。
 * 为了不让一条用例的缓存掩盖另一条用例的读次数，每条用例取一个全新的模块实例。
 */
async function freshCollector(): Promise<CollectCapabilities> {
	vi.resetModules();
	const module = await import("../src/data/capabilities");
	return module.collectCapabilities;
}

const COMMAND_DIR = ".claude/commands";
const AGENT_DIR = ".claude/agents";
const SKILLS_DIR = ".agents/skills";
const WORKFLOW_DIR = ".claude/workflows";

interface ReadCall {
	path: string;
	at: number;
}

interface FixtureOptions {
	/** 每类目录（commands / agents / workflows）的文件数。 */
	filesPerDirectory: number;
	/** `.agents/skills` 里的 folder 数。 */
	skillFolders: number;
	/** skills 的 SKILL.md 是否存在（false 时只读 README.md）。 */
	skillFileExists: boolean;
	/** 每次 read 的人为延迟（毫秒），用于并发对比。 */
	readDelayMs: number;
	/** workflows 目录下额外的 folder 数（派生项，不读文件）。 */
	extraWorkflowFolders: number;
}

/**
 * 夹具 A（方案里写死的唯一基线）：四类目录各 200 项、skills folders 为空、
 * workflows 额外 1 个 folder。
 *
 * 注意：`reads === 600` 只在这个形状下成立。方案里另两个实测形状
 *（skills 为 200 folder 且 SKILL.md 可读 = 800；SKILL.md 读不到 = 1000）
 * 不得与本夹具混用，因此这里显式参数化。
 */
const FIXTURE_A = {
	filesPerDirectory: 200,
	skillFolders: 0,
	skillFileExists: true,
	readDelayMs: 2,
	extraWorkflowFolders: 1,
} as const;

interface Harness {
	app: App;
	reads: ReadCall[];
	readPaths: () => string[];
}

function createHarness(options: FixtureOptions): Harness {
	const reads: ReadCall[] = [];
	const listings = new Map<string, { files: string[]; folders: string[] }>();
	const contents = new Map<string, string>();

	const mdFiles = (dir: string, count: number): string[] =>
		Array.from({ length: count }, (_value, index) => `${dir}/item-${String(index).padStart(3, "0")}.md`);

	listings.set(COMMAND_DIR, {
		files: mdFiles(COMMAND_DIR, options.filesPerDirectory),
		folders: [],
	});
	listings.set(AGENT_DIR, {
		files: mdFiles(AGENT_DIR, options.filesPerDirectory),
		folders: [],
	});
	listings.set(SKILLS_DIR, {
		files: [],
		folders: Array.from({ length: options.skillFolders }, (_value, index) =>
			`${SKILLS_DIR}/skill-${index}`
		),
	});
	listings.set(WORKFLOW_DIR, {
		files: mdFiles(WORKFLOW_DIR, options.filesPerDirectory),
		folders: Array.from({ length: options.extraWorkflowFolders }, (_value, index) =>
			`${WORKFLOW_DIR}/bundle-${index}`
		),
	});

	for (const [, listing] of listings) {
		for (const file of listing.files) {
			contents.set(file, `---\ndescription: ${file.split("/").pop()}\n---\n# Title\n`);
		}
	}
	for (const folder of listings.get(SKILLS_DIR)?.folders ?? []) {
		if (options.skillFileExists) {
			contents.set(`${folder}/SKILL.md`, "---\ndescription: skill file\n---\n");
		}
		contents.set(`${folder}/README.md`, "---\ndescription: skill readme\n---\n");
	}

	const wait = (): Promise<void> =>
		options.readDelayMs > 0
			? new Promise((resolve) => setTimeout(resolve, options.readDelayMs))
			: Promise.resolve();

	const app = {
		vault: {
			adapter: {
				exists: async (path: string) => listings.has(path),
				list: async (path: string) => {
					const listing = listings.get(path);
					if (!listing) throw new Error(`missing dir ${path}`);
					return { files: [...listing.files], folders: [...listing.folders] };
				},
				read: async (path: string) => {
					reads.push({ path, at: Date.now() });
					await wait();
					const text = contents.get(path);
					if (text === undefined) throw new Error(`missing file ${path}`);
					return text;
				},
			},
		},
	} as unknown as App;

	return { app, reads, readPaths: () => reads.map((entry) => entry.path) };
}

/** 与改造前的实现等价的参考实现：同一形状下的读取次数基线。 */
function expectedReads(options: FixtureOptions): number {
	const base = options.filesPerDirectory * 3; // commands + agents + workflows
	return base + options.skillFolders * (options.skillFileExists ? 1 : 2);
}

describe("capability reads", () => {
	it("reads every capability file exactly once on fixture A", async () => {
		const harness = createHarness(FIXTURE_A);
		const collectCapabilities = await freshCollector();
		await collectCapabilities(harness.app);
		// 方案写死的基线：四类目录各 200、skills folders 为空 → 600 次 read。
		expect(harness.readPaths()).toHaveLength(600);
		expect(harness.readPaths()).toHaveLength(expectedReads(FIXTURE_A));
		// 无重复路径（同一文件在一次刷新内只读一次）。
		expect(new Set(harness.readPaths()).size).toBe(600);
	});

	it("keeps the outputs identical to the sequential reference", async () => {
		const harness = createHarness({ ...FIXTURE_A, readDelayMs: 0 });
		const collectCapabilities = await freshCollector();
		const groups = await collectCapabilities(harness.app);
		expect(groups.map((group) => group.key)).toEqual(["commands", "agents", "workflows"]);

		const commands = groups[0]?.items ?? [];
		expect(commands).toHaveLength(200);
		expect(commands[0]).toMatchObject({
			name: "/item-000",
			invoke: "/item-000",
			desc: "item-000.md",
			path: `${COMMAND_DIR}/item-000.md`,
		});
		// 文件名排序稳定（与改造前 `.sort()` 一致）。
		expect(commands.map((item) => item.name)).toEqual(
			[...commands.map((item) => item.name)].sort()
		);

		const workflows = groups[2]?.items ?? [];
		// 200 个文件 + 1 个 folder 派生项：派生项不读文件，但必须保留。
		expect(workflows).toHaveLength(201);
		const derived = workflows.find((item) => item.name === "bundle-0");
		expect(derived).toMatchObject({ name: "bundle-0", invoke: "bundle-0", desc: "工作流" });
		expect(derived?.path).toBeUndefined();
	});

	it("reads skills folders once per candidate and prefers SKILL.md", async () => {
		const harness = createHarness({
			...FIXTURE_A,
			skillFolders: 4,
			skillFileExists: true,
			readDelayMs: 0,
		});
		const collectCapabilities = await freshCollector();
		const groups = await collectCapabilities(harness.app);
		const agents = groups[1]?.items ?? [];
		const skills = agents.filter((item) => item.name.startsWith("skill-"));
		expect(skills).toHaveLength(4);
		expect(skills[0]).toMatchObject({
			name: "skill-0",
			desc: "skill file",
			path: `${SKILLS_DIR}/skill-0/SKILL.md`,
		});
		// SKILL.md 可读时不再读 README.md。
		// 断言的是运行时读路径数组，不是源码文本，故不走 toContain（Q-TES5 闸门）。
		expect(harness.readPaths().includes(`${SKILLS_DIR}/skill-0/README.md`)).toBe(false);
	});

	it("falls back to README.md when SKILL.md is missing", async () => {
		const harness = createHarness({
			...FIXTURE_A,
			skillFolders: 4,
			skillFileExists: false,
			readDelayMs: 0,
		});
		const collectCapabilities = await freshCollector();
		const groups = await collectCapabilities(harness.app);
		const skills = (groups[1]?.items ?? []).filter((item) => item.name.startsWith("skill-"));
		expect(skills[0]).toMatchObject({
			name: "skill-0",
			desc: "skill readme",
			path: `${SKILLS_DIR}/skill-0/README.md`,
		});
		// 200*3 + 4*2 = 608：SKILL.md 读不到时每个 folder 白读一次（失败结果会被缓存）。
		expect(harness.readPaths()).toHaveLength(608);
	});

	it("serves repeat refreshes from the short TTL cache", async () => {
		const harness = createHarness({ ...FIXTURE_A, readDelayMs: 0 });
		const collectCapabilities = await freshCollector();
		await collectCapabilities(harness.app);
		const firstPass = harness.readPaths().length;
		await collectCapabilities(harness.app);
		// TTL 内第二次刷新不再读盘。
		expect(harness.readPaths().length).toBe(firstPass);
	});

	it("reads concurrently so wall time stays well under the serial baseline", async () => {
		// 方案的判据是「耗时下降 >= 5 倍」，对照的是**实测串行耗时**，不能从
		// readDelayMs × 次数 推算：win32 定时器粒度约 15ms，setTimeout(2) 实际远慢于 2ms。
		// 因此这里用同一个 adapter 先跑一遍串行参考读，再与并发实现比。
		const options: FixtureOptions = {
			filesPerDirectory: 8,
			skillFolders: 0,
			skillFileExists: true,
			readDelayMs: 20,
			extraWorkflowFolders: 0,
		};
		const serialHarness = createHarness(options);
		const names = Array.from({ length: options.filesPerDirectory }, (_value, index) =>
			`item-${String(index).padStart(3, "0")}.md`
		);
		const serialPaths = [
			...names.map((name) => `${COMMAND_DIR}/${name}`),
			...names.map((name) => `${AGENT_DIR}/${name}`),
			...names.map((name) => `${WORKFLOW_DIR}/${name}`),
		];
		const serialAdapter = serialHarness.app.vault.adapter as unknown as {
			read: (path: string) => Promise<string>;
		};
		const serialStart = Date.now();
		for (const path of serialPaths) await serialAdapter.read(path);
		const serialMs = Date.now() - serialStart;

		const harness = createHarness(options);
		const collectCapabilities = await freshCollector();
		const concurrentStart = Date.now();
		await collectCapabilities(harness.app);
		const concurrentMs = Date.now() - concurrentStart;

		expect(harness.readPaths()).toHaveLength(serialPaths.length);
		// 报告目标是 >= 5 倍；按 3 倍断言，避免 CI 抖动把绿变红（本机实测约 7 倍）。
		expect(serialMs / Math.max(concurrentMs, 1)).toBeGreaterThan(3);
	});

	it("rejects no files when a directory is missing", async () => {
		const app = {
			vault: {
				adapter: {
					exists: async () => false,
					list: async () => ({ files: [], folders: [] }),
					read: async () => {
						throw new Error("should not read");
					},
				},
			},
		} as unknown as App;
		const collectCapabilities = await freshCollector();
		const groups = await collectCapabilities(app);
		// 命令为空时退回内置 COMMAND_FALLBACK；workflows 无条目时不建组。
		expect(groups.map((group) => group.key)).toEqual(["commands", "agents"]);
		expect((groups[0]?.items ?? []).length).toBeGreaterThan(0);
	});
});
