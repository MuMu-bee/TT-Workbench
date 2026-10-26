import { describe, expect, it } from "vitest";
import { AUDIT_ROTATE_BYTES, rotateIfOversized, type RotationFileHost } from "../src/ai/privacy/audit-rotation";
import { PortableConversationStore, type PortableFileAdapter } from "../src/agent-workbench/storage/portable-conversation-store";

/** 记录所有文件系统操作的假适配器,用于断言"写路径不再全量扫描会话目录"。 */
class CountingFiles implements PortableFileAdapter {
	files = new Map<string, string>();
	folders = new Set<string>();
	listCalls: string[] = [];
	async exists(path: string) { return this.files.has(path) || this.folders.has(path); }
	async read(path: string) {
		const value = this.files.get(path);
		if (value === undefined) throw new Error(`missing ${path}`);
		return value;
	}
	async write(path: string, content: string) { this.files.set(path, content); }
	async mkdir(path: string) { this.folders.add(path); }
	async remove(path: string) { this.files.delete(path); }
	async rename(from: string, to: string) {
		const value = this.files.get(from);
		if (value === undefined) throw new Error(`missing ${from}`);
		this.files.delete(from);
		this.files.set(to, value);
	}
	async replace(from: string, to: string) { await this.rename(from, to); }
	async list(path: string) {
		this.listCalls.push(path);
		const prefix = `${path}/`;
		const names = [...this.files.keys(), ...this.folders].filter((key) => key.startsWith(prefix));
		const files: string[] = [];
		const folders = new Set<string>();
		for (const key of names) {
			const rest = key.slice(prefix.length);
			if (rest.includes("/")) folders.add(rest.split("/")[0]);
			else files.push(rest);
		}
		return { files, folders: [...folders] };
	}
}

const manifest = (id: string, updatedAt = "2026-01-01T00:00:00.000Z") => ({
	schemaVersion: 1 as const,
	conversationId: id,
	title: `会话 ${id}`,
	createdAt: updatedAt,
	updatedAt,
	lifecycle: "active" as const,
	selection: { runtimeId: "ohmypi" as const },
});

describe("P2 索引增量维护", () => {
	it("写 manifest 时不再全量扫描会话目录,只读改写单个索引项", async () => {
		const files = new CountingFiles();
		const store = new PortableConversationStore(files);
		await store.create(manifest("a"));
		await store.create(manifest("b"));
		await store.create(manifest("c"));
		files.listCalls = [];
		await store.updateManifest(manifest("b", "2026-02-02T00:00:00.000Z"));

		// 旧实现每次 updateManifest 都会 list(".../conversations") 做全量重建。
		expect(files.listCalls.filter((path) => path.endsWith("/conversations"))).toHaveLength(0);
		const listed = await store.list();
		expect(listed.map((item) => item.conversationId).sort()).toEqual(["a", "b", "c"]);
		expect(listed.find((item) => item.conversationId === "b")?.updatedAt).toBe("2026-02-02T00:00:00.000Z");
	});

	it("新建与生命周期变更同样只维护索引项,不触发全量扫描", async () => {
		const files = new CountingFiles();
		const store = new PortableConversationStore(files);
		await store.create(manifest("x"));
		await store.create(manifest("y"));
		files.listCalls = [];
		await store.setLifecycle("x", "deleted");
		expect(files.listCalls.filter((path) => path.endsWith("/conversations"))).toHaveLength(0);
		const listed = await store.list();
		expect(listed.map((item) => item.conversationId).sort()).toEqual(["x", "y"]);
		expect(listed.find((item) => item.conversationId === "x")?.lifecycle).toBe("deleted");
	});

	it("索引缺失或损坏时仍能回退重建,数据不丢", async () => {
		const files = new CountingFiles();
		const store = new PortableConversationStore(files);
		await store.create(manifest("keep"));
		const indexKey = [...files.files.keys()].find((key) => key.endsWith("index.json"));
		expect(indexKey).toBeTruthy();
		files.files.set(indexKey!, "{ not json");
		expect((await store.list()).map((item) => item.conversationId)).toEqual(["keep"]);
	});
});

describe("P5 审计文件轮转", () => {
	const host = (size: number | null): RotationFileHost & { renamed: Array<[string, string]> } => {
		const renamed: Array<[string, string]> = [];
		return {
			renamed,
			size: async () => size,
			rename: async (from, to) => { renamed.push([from, to]); },
		};
	};

	it("未达上限时不轮转", async () => {
		const h = host(1024);
		expect(await rotateIfOversized("audit.jsonl", h)).toBe(false);
		expect(h.renamed).toHaveLength(0);
	});

	it("达到上限时重命名为 .1 备份,不删除记录", async () => {
		const h = host(AUDIT_ROTATE_BYTES);
		expect(await rotateIfOversized("audit.jsonl", h)).toBe(true);
		expect(h.renamed).toEqual([["audit.jsonl", "audit.jsonl.1"]]);
	});

	it("文件不存在时视为无需轮转", async () => {
		const h = host(null);
		expect(await rotateIfOversized("audit.jsonl", h)).toBe(false);
	});
});

describe("P4 工具结果缓存不跨回合累积", () => {
	it("会话服务在回合之间不持有工具结果缓存", async () => {
		// ApiAgentRuntime 的 toolResults 在每回合 finally 中清理;
		// 此处锁定"每回合清理"的存在性,防止回退成无界累积。
		const { readFileSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const root = fileURLToPath(new URL("../", import.meta.url));
		const source = readFileSync(`${root}src/ai/provider/api-agent-runtime.ts`, "utf8");
		expect(source).toContain("scopeCacheKeys");
		expect(source).toMatch(/\.finally\(\(\) => \{\n\s+for \(const key of scopeCacheKeys\) this\.toolResults\.delete\(key\);/);
	});
});

describe("P1/P3 输入防抖", () => {
	it("历史搜索与 @建议均改为防抖调度,而非每键直调", async () => {
		const { readFileSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const root = fileURLToPath(new URL("../", import.meta.url));
		const view = readFileSync(`${root}src/agent-workbench/ui/native-conversation-view.ts`, "utf8");
		const composer = readFileSync(`${root}src/agent-workbench/ui/native-composer.ts`, "utf8");
		expect(view).toContain("historyDebounce");
		expect(view).toContain("cachedHistoryProjection");
		expect(composer).toContain("suggestionDebounce");
		expect(composer).toContain("cachedMarkdownFiles");
	});
});

describe("旧版工作台设置迁移(升级路径)", () => {
	it("把上游 claude/codex/hermes 的 runtimeId 静默迁移到 ohmypi,而不是抛错", async () => {
		const { WorkbenchSettingsStore } = await import("../src/agent-workbench/storage/workbench-settings-store");
		let stored: unknown = {
			schemaVersion: 1,
			runtimes: [{ id: "codex-local", runtimeId: "codex", executablePath: "/synthetic/codex" }],
			providers: [
				{
					id: "openai-compatible",
					displayName: "OpenAI-compatible · Direct API",
					runtimeId: "codex",
					protocol: "openai-chat",
					endpoint: "https://api.example.test/v1",
					models: ["step-5-preview"],
					secretRef: "talos-openai-api-key",
					enabled: true,
				},
			],
			selection: { runtimeId: "hermes", providerProfileId: "hermes" },
			workflow: "execute",
			permission: "vault-full",
		};
		const store = new WorkbenchSettingsStore(
			{ read: async () => structuredClone(stored), write: async (v) => { stored = structuredClone(v); } },
			{ has: () => true },
		);
		const loaded = await store.load();
		expect(loaded.providers).toHaveLength(1);
		expect(loaded.providers[0]?.runtimeId).toBe("ohmypi");
		expect(loaded.providers[0]?.protocol).toBe("openai-chat");
		expect(loaded.providers[0]?.models).toEqual(["step-5-preview"]);
		expect(loaded.selection.runtimeId).toBe("ohmypi");
		// workflow / permission 不属于运行时,必须原样保留
		expect(loaded.workflow).toBe("execute");
		expect(loaded.permission).toBe("vault-full");
		// runtime profile 保留(用户的可执行路径不丢),仅 runtimeId 归一到 ohmypi
		expect(loaded.runtimes).toHaveLength(1);
		expect(loaded.runtimes[0]).toMatchObject({ runtimeId: "ohmypi", executablePath: "/synthetic/codex" });
	});

	it("缺失或损坏的 selection 回落到默认运行时而不抛错", async () => {
		const { WorkbenchSettingsStore } = await import("../src/agent-workbench/storage/workbench-settings-store");
		const store = new WorkbenchSettingsStore(
			{
				read: async () => ({ schemaVersion: 1, runtimes: [], providers: [], selection: null, workflow: "plan", permission: "ask" }),
				write: async () => undefined,
			},
			{ has: () => false },
		);
		await expect(store.load()).resolves.toMatchObject({ selection: { runtimeId: "ohmypi" } });
	});
	it("丢弃本版不支持的旧协议 profile,保留其余可用配置", async () => {
		const { WorkbenchSettingsStore } = await import("../src/agent-workbench/storage/workbench-settings-store");
		const store = new WorkbenchSettingsStore(
			{
				read: async () => ({
					schemaVersion: 1,
					runtimes: [],
					providers: [
						{ id: "openai-compatible", displayName: "OK", runtimeId: "codex", protocol: "openai-chat", endpoint: "https://api.example.test/v1", models: ["m1"], secretRef: "r1", enabled: true },
						{ id: "hermes", displayName: "Hermes", runtimeId: "hermes", protocol: "hermes-agent", models: ["hermes-agent"], secretRef: "r2", enabled: true },
					],
					selection: { runtimeId: "ohmypi" },
					workflow: "plan",
					permission: "ask",
				}),
				write: async () => undefined,
			},
			{ has: () => true },
		);
		const loaded = await store.load();
		expect(loaded.providers.map((p) => p.id)).toEqual(["openai-compatible"]);
		expect(loaded.providers[0]?.runtimeId).toBe("ohmypi");
	});
});
