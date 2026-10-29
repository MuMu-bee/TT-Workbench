import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchConversationCoordinator } from "../src/agent-workbench/core/workbench-conversation-coordinator";
import { ConversationService } from "../src/agent-workbench/core/conversation-service";
import { ClaudianReadonlyImporter, type LegacyImportState } from "../src/agent-workbench/legacy/claudian-readonly-importer";
import { ObsidianLegacyReadAdapter, ObsidianWorkbenchStorage, type VaultDataAdapter } from "../src/agent-workbench/storage/obsidian-workbench-storage";
import { PortableConversationStore } from "../src/agent-workbench/storage/portable-conversation-store";
import { RuntimeBindingStore } from "../src/agent-workbench/storage/runtime-binding-store";

const created: string[] = [];
afterEach(async () => {
	for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true });
});

class NodeVaultAdapter implements VaultDataAdapter {
	constructor(private readonly root: string) {}
	private resolve(relative: string): string { return path.join(this.root, relative); }
	async exists(relative: string): Promise<boolean> {
		try { await access(this.resolve(relative)); return true; } catch { return false; }
	}
	async read(relative: string): Promise<string> { return readFile(this.resolve(relative), "utf8"); }
	async write(relative: string, value: string): Promise<void> { await writeFile(this.resolve(relative), value); }
	async remove(relative: string): Promise<void> { await rm(this.resolve(relative), { force: true }); }
	async rmdir(relative: string, recursive: boolean): Promise<void> {
		await rm(this.resolve(relative), { recursive, force: recursive });
	}
	async mkdir(relative: string): Promise<void> { await mkdir(this.resolve(relative)); }
	async list(relative: string): Promise<{ files: string[]; folders: string[] }> {
		const entries = await readdir(this.resolve(relative), { withFileTypes: true });
		return {
			files: entries.filter((entry) => entry.isFile()).map((entry) => path.posix.join(relative, entry.name)),
			folders: entries.filter((entry) => entry.isDirectory()).map((entry) => path.posix.join(relative, entry.name)),
		};
	}
}

describe("AgentWorkbench composition persistence", () => {
	it("imports legacy bytes read-only and keeps portable events separate from native bindings", async () => {
		const vault = await mkdtemp(path.join(tmpdir(), "talos-composition-"));
		// 刻意构造 win32 根相对形态（`\synthetic-home`，单反斜杠开头、无盘符）。
		// 这不是「测试误用 POSIX 风格」：`path.win32.isAbsolute('\synthetic-home\a.md')` 为 true，
		// 该形态在真实 win32 上是绝对路径，产品侧的 sanitizePortableString /
		// assertPortableValue 必须覆盖它（见 portable-conversation-store.ts:43 的 WINDOWS_ROOTED
		// 与 ACCEPTANCE.md「已知产品缺陷」第 1 条）。
		const syntheticHome = path.join(path.sep, "synthetic-home");
		created.push(vault);
		const legacyDirectory = path.join(vault, ".talos", "quyuan", "sessions");
		await mkdir(legacyDirectory, { recursive: true });
		const metadataPath = path.join(legacyDirectory, "legacy.meta.json");
		const messagesPath = path.join(legacyDirectory, "legacy.messages.json");
		const metadataBytes = JSON.stringify({
			id: "legacy",
			providerId: "codex",
			title: "旧会话",
			createdAt: 1,
			updatedAt: 2,
		});
		const messageBytes = JSON.stringify([
			{ id: "u1", role: "user", content: "合成问题", timestamp: 1 },
			{ id: "a1", role: "assistant", content: "合成答案", timestamp: 2 },
		]);
		await writeFile(metadataPath, metadataBytes);
		await writeFile(messagesPath, messageBytes);

		const adapter = new NodeVaultAdapter(vault);
		const portable = new ObsidianWorkbenchStorage(adapter, vault);
		const conversations = new ConversationService(new PortableConversationStore(portable));
		let bindingState: Record<string, unknown> | null = null;
		const bindings = new RuntimeBindingStore({
			read: async () => structuredClone(bindingState),
			write: async (value) => { bindingState = structuredClone(value); },
		});
		const manifestPath = ".talos/agent-workbench/v1/import-manifest.json";
		const importer = new ClaudianReadonlyImporter(
			new ObsidianLegacyReadAdapter(adapter),
			conversations,
			{
				read: () => portable.readJson<LegacyImportState>(manifestPath),
				write: (state) => portable.writeJsonAtomic(manifestPath, state),
			},
		);
		const coordinator = new WorkbenchConversationCoordinator(conversations, bindings, importer);
		await coordinator.initialize();
		expect(coordinator.getImportReport()).toMatchObject({ full: 1, partial: 0, skipped: 0 });
		await coordinator.initialize();
		expect(coordinator.getImportReport()).toMatchObject({ full: 0, skipped: 1 });
		expect(await readFile(metadataPath, "utf8")).toBe(metadataBytes);
		expect(await readFile(messagesPath, "utf8")).toBe(messageBytes);

		const manifest = await coordinator.ensure({
			conversationId: "portable-1",
			title: "Portable",
			runtimeId: "ohmypi",
		});
		await coordinator.appendUser({
			conversationId: manifest.conversationId,
			turnId: "turn-1",
			runtimeId: "ohmypi",
			text: "read " + vault + "/note.md with sk-synthetic-123456789",
			vaultRoot: vault,
		});
		await coordinator.appendRuntimeEvent(manifest.conversationId, {
			schemaVersion: 1,
			eventId: "runtime-1",
			conversationId: "native-session",
			turnId: "turn-1",
			runtimeId: "ohmypi",
			type: "tool.started",
			timestamp: "2026-08-26T00:00:00.000Z",
			nativeId: path.join(syntheticHome, ".codex/native/request.json"),
			payload: { path: vault + "/note.md", vaultRoot: vault, authorization: "Bearer synthetic" },
		}, vault);
		await coordinator.setBinding(manifest.conversationId, {
			runtimeId: "ohmypi",
			sessionId: "native-session",
			nativeResumeToken: vault + "/native/session.jsonl",
		});

		// RuntimeId 已收窄为 "ohmypi"，新建会话不再能指定 legacy 运行时。切换仍要覆盖：
		// 旧版本落盘的 manifest 里 runtimeId 仍是历史字符串（runtime-adapter.ts:5-8
		// 注释说明读取层按未知 runtime 降级），所以这里按真实持久化形态改写磁盘上的
		// manifest，再走公开的 switchRuntime 走一遍 handoff 生成。
		const manifestFile = path.join(
			vault,
			`.talos/agent-workbench/v1/conversations/${manifest.conversationId}/manifest.json`,
		);
		const storedManifest = JSON.parse(await readFile(manifestFile, "utf8")) as {
			selection: { runtimeId: string };
		};
		await writeFile(manifestFile, JSON.stringify({
			...storedManifest,
			selection: { runtimeId: "codex" },
		}, null, 2) + "\n");
		expect(await coordinator.switchRuntime(manifest.conversationId, "ohmypi")).toBe(true);

		const projection = await conversations.store.load(manifest.conversationId);
		expect(projection.events).toHaveLength(3);
		expect(new Set(projection.events.map((event) => event.type))).toEqual(new Set([
			"user.message",
			"tool.started",
			"handoff.created",
		]));
		const portableBytes = JSON.stringify(projection);
		expect(portableBytes).not.toContain(vault);
		// 产品不变量守护，不是平台差异：`syntheticHome` 是刻意构造的 win32 根相对绝对路径，
		// 它出现在可移植会话文件里就等于本机路径外泄。这条断言的方向正确，不得改弱
		// （删掉它或改成 `toContain` 都会把产品缺口封存）。修复在
		// src/agent-workbench/storage/portable-conversation-store.ts 的 sanitize/assert。
		expect(portableBytes).not.toContain(syntheticHome);
		expect(portableBytes).not.toContain("sk-synthetic");
		expect(portableBytes).not.toContain("authorization");
		expect(await coordinator.getBinding(manifest.conversationId, "ohmypi")).toMatchObject({
			sessionId: "native-session",
			nativeResumeToken: vault + "/native/session.jsonl",
		});
		await expect(portable.write("../escape.json", "{}")).rejects.toThrow("越过 Vault");
	});

	/**
	 * RuntimeId 已收窄为 "ohmypi"，`ConversationService.create` 不能再接受历史运行时名。
	 * 旧版本落盘的 manifest 里 runtimeId 仍是历史字符串（runtime-adapter.ts:5-8
	 * 说明读取层按未知 runtime 降级），所以用本函数按真实持久化形态改写磁盘上的
	 * manifest，让「从 legacy 运行时切到 ohmypi」这条路径仍然可测。
	 */
	async function seedLegacyRuntime(
		vault: string,
		conversationId: string,
		legacyRuntimeId: string,
	): Promise<void> {
		const manifestFile = path.join(
			vault,
			`.talos/agent-workbench/v1/conversations/${conversationId}/manifest.json`,
		);
		const stored = JSON.parse(await readFile(manifestFile, "utf8")) as {
			selection: { runtimeId: string };
		};
		await writeFile(manifestFile, `${JSON.stringify({
			...stored,
			selection: { runtimeId: legacyRuntimeId },
		}, null, 2)}\n`);
	}

	it("switches an empty new conversation without creating or inheriting handoff context", async () => {
		const vault = await mkdtemp(path.join(tmpdir(), "talos-empty-conversation-"));
		created.push(vault);
		const adapter = new NodeVaultAdapter(vault);
		const portable = new ObsidianWorkbenchStorage(adapter, vault);
		const conversations = new ConversationService(new PortableConversationStore(portable));
		const coordinator = new WorkbenchConversationCoordinator(
			conversations,
			new RuntimeBindingStore({
				read: async () => null,
				write: async () => undefined,
			}),
		);
		const manifest = await conversations.create("新会话");
		await seedLegacyRuntime(vault, manifest.conversationId, "codex");
		expect(await coordinator.switchRuntime(manifest.conversationId, "ohmypi")).toBe(false);
		const projection = await conversations.store.load(manifest.conversationId);
		expect(projection.events).toEqual([]);
		expect(projection.manifest.selection).toEqual({ runtimeId: "ohmypi" });
		expect(await coordinator.getBinding(manifest.conversationId, "ohmypi")).toBeNull();

		const discardable = await conversations.create("新会话");
		await seedLegacyRuntime(vault, discardable.conversationId, "claude");
		expect(await coordinator.switchRuntime(discardable.conversationId, "ohmypi")).toBe(false);
		await expect(adapter.rmdir(
			`.talos/agent-workbench/v1/conversations/${discardable.conversationId}/events`,
			false,
		)).rejects.toThrow();
		await expect(conversations.discardEmpty(discardable.conversationId)).resolves.toBe(true);
		await expect(access(path.join(
			vault,
			".talos/agent-workbench/v1/conversations",
			discardable.conversationId,
		))).rejects.toMatchObject({ code: "ENOENT" });

		// 空 payload 的历史 handoff 不得被当成可继承上下文：切换仍返回 false，
		// 且 selection 直接改到目标运行时、不追加新的 handoff.created。
		await seedLegacyRuntime(vault, manifest.conversationId, "claude");
		await conversations.append({
			conversationId: manifest.conversationId,
			turnId: "legacy-empty-handoff",
			runtimeId: "ohmypi",
			type: "handoff.created",
			payload: {
				goal: "",
				recentMessages: [],
				incompleteTasks: [],
				toolResultSummaries: [],
				vaultRelativeReferences: [],
			},
		});
		expect(await coordinator.switchRuntime(manifest.conversationId, "ohmypi")).toBe(false);
		const legacyProjection = await conversations.store.load(manifest.conversationId);
		expect(legacyProjection.events).toHaveLength(1);
		expect(legacyProjection.manifest.selection).toEqual({ runtimeId: "ohmypi" });
	});
});
