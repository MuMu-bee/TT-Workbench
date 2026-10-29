import { describe, expect, it } from "vitest";
import { createAgentEvent } from "../src/agent-workbench/contracts/agent-events";
import type { ConversationManifest } from "../src/agent-workbench/contracts/conversation";
import { hasMeaningfulHandoffContext } from "../src/agent-workbench/storage/conversation-projection";
import { ConversationService } from "../src/agent-workbench/core/conversation-service";
import { WorkbenchConversationCoordinator } from "../src/agent-workbench/core/workbench-conversation-coordinator";
import {
	assertPortableValue,
	FORBIDDEN_KEY,
	sanitizePortableString,
	sanitizePortableValue,
	PortableConversationStore,
	type PortableFileAdapter,
} from "../src/agent-workbench/storage/portable-conversation-store";
import { RuntimeBindingStore } from "../src/agent-workbench/storage/runtime-binding-store";

class MemoryFiles implements PortableFileAdapter {
	readonly files = new Map<string, string>();
	readonly folders = new Set<string>();
	async exists(path: string) { return this.files.has(path) || this.folders.has(path); }
	async read(path: string) {
		const value = this.files.get(path);
		if (value === undefined) throw new Error(`missing: ${path}`);
		return value;
	}
	async write(path: string, value: string) { this.files.set(path, value); }
	async rename(from: string, to: string) {
		const value = await this.read(from);
		this.files.set(to, value);
		this.files.delete(from);
	}
	async replace(from: string, to: string) { await this.rename(from, to); }
	async remove(path: string) {
		if (this.folders.has(path)) throw new Error(`remove cannot delete directory: ${path}`);
		this.files.delete(path);
	}
	async rmdir(path: string, recursive: boolean) {
		const prefix = `${path}/`;
		const children = [...this.files.keys(), ...this.folders].filter((candidate) => candidate.startsWith(prefix));
		if (!recursive && children.length > 0) throw new Error(`directory not empty: ${path}`);
		for (const candidate of children) {
			this.files.delete(candidate);
			this.folders.delete(candidate);
		}
		this.folders.delete(path);
	}
	async mkdir(path: string) { this.folders.add(path); }
	async list(path: string) {
		const prefix = `${path}/`;
		const files = new Set<string>();
		const folders = new Set<string>();
		for (const candidate of this.files.keys()) {
			if (!candidate.startsWith(prefix)) continue;
			const suffix = candidate.slice(prefix.length);
			const slash = suffix.indexOf("/");
			if (slash < 0) files.add(suffix);
			else folders.add(suffix.slice(0, slash));
		}
		for (const candidate of this.folders) {
			if (!candidate.startsWith(prefix)) continue;
			const suffix = candidate.slice(prefix.length);
			if (suffix && !suffix.includes("/")) folders.add(suffix);
		}
		return { files: [...files], folders: [...folders] };
	}
}

const manifest: ConversationManifest = {
	schemaVersion: 1,
	conversationId: "conv-1",
	title: "Portable",
	createdAt: "2026-08-26T00:00:00.000Z",
	updatedAt: "2026-08-26T00:00:00.000Z",
	lifecycle: "active",
	selection: { runtimeId: "ohmypi" },
};

function event(id = "event-1") {
	return createAgentEvent({
		eventId: id,
		conversationId: "conv-1",
		turnId: "turn-1",
		runtimeId: "ohmypi",
		type: "assistant.final",
		timestamp: "2026-08-26T00:00:01.000Z",
		payload: { text: "done", vaultPath: "00 收件箱/test.md" },
	});
}

describe("PortableConversationStore", () => {
	it("physically discards only untouched blank conversations", async () => {
		const files = new MemoryFiles();
		const store = new PortableConversationStore(files);
		const conversations = new ConversationService(store);
		const blank = await conversations.create();
		const named = await conversations.create("keep me");
		const used = await conversations.create();
		const guarded = await conversations.create();
		files.files.set(`.talos/agent-workbench/v1/conversations/${guarded.conversationId}/recovery.bin`, "preserve");
		await conversations.append({
			conversationId: used.conversationId,
			turnId: "turn-used",
			runtimeId: "ohmypi",
			type: "user.message",
			payload: { text: "real content" },
		});

		await expect(conversations.discardEmpty(blank.conversationId)).resolves.toBe(true);
		await expect(conversations.discardEmpty(named.conversationId)).resolves.toBe(false);
		await expect(conversations.discardEmpty(used.conversationId)).resolves.toBe(false);
		await expect(conversations.discardEmpty(guarded.conversationId)).resolves.toBe(false);
		expect((await store.list()).map((item) => item.conversationId)).toEqual(expect.arrayContaining([named.conversationId, used.conversationId]));
		expect((await store.list()).map((item) => item.conversationId)).not.toContain(blank.conversationId);
		await expect(store.load(blank.conversationId)).rejects.toThrow();
		expect([...files.folders]).not.toContain(`.talos/agent-workbench/v1/conversations/${blank.conversationId}`);
		expect(files.files.get(`.talos/agent-workbench/v1/conversations/${guarded.conversationId}/recovery.bin`)).toBe("preserve");
	});

	it("writes immutable events idempotently and rejects collisions", async () => {
		const files = new MemoryFiles();
		const store = new PortableConversationStore(files);
		await store.create(manifest);
		expect(await store.append(event())).toBe("written");
		expect(await store.append(event())).toBe("duplicate");
		await expect(store.append({ ...event(), payload: { text: "changed" } })).rejects.toThrow("冲突");
	});

	it("rebuilds chronological order independently of hashed event filenames", async () => {
		const files = new MemoryFiles();
		const store = new PortableConversationStore(files);
		await store.create(manifest);
		await store.append({ ...event("z-late"), timestamp: "2026-08-26T00:00:03.000Z" });
		await store.append({ ...event("a-early"), timestamp: "2026-08-26T00:00:02.000Z" });
		expect((await store.load("conv-1")).events.map((item) => item.eventId)).toEqual(["a-early", "z-late"]);
		expect([...files.files.keys()].join("\n")).not.toMatch(/a-early|z-late/);
		await expect(store.create({ ...manifest, conversationId: "../escape" })).rejects.toThrow("安全路径段");
	});

	it("keeps the user prompt before provider events when reloading a turn", async () => {
		const store = new PortableConversationStore(new MemoryFiles());
		await store.create(manifest);
		await store.append(createAgentEvent({
			eventId: "provider-first",
			conversationId: "conv-1",
			turnId: "turn-1",
			runtimeId: "ohmypi",
			type: "assistant.delta",
			timestamp: "2026-08-26T00:00:01.000Z",
			payload: { text: "answer" },
		}));
		await store.append(createAgentEvent({
			eventId: "user-after-acceptance",
			conversationId: "conv-1",
			turnId: "turn-1",
			runtimeId: "ohmypi",
			type: "user.message",
			timestamp: "2026-08-26T00:00:02.000Z",
			payload: { text: "question" },
		}));
		await store.append(createAgentEvent({
			eventId: "assistant-start",
			conversationId: "conv-1",
			turnId: "turn-1",
			runtimeId: "ohmypi",
			type: "assistant.start",
			timestamp: "2026-08-26T00:00:03.000Z",
			payload: {},
		}));
		expect((await store.load("conv-1")).events.map((item) => item.type)).toEqual([
			"user.message",
			"assistant.start",
			"assistant.delta",
		]);
	});

	it("does not render legacy handoff markers that contain no context", () => {
		expect(hasMeaningfulHandoffContext(createAgentEvent({
			eventId: "empty-handoff",
			conversationId: "conv-1",
			turnId: "handoff-1",
			runtimeId: "ohmypi",
			type: "handoff.created",
			timestamp: "2026-08-26T00:00:01.000Z",
			payload: {
				goal: "",
				recentMessages: [],
				incompleteTasks: [],
				toolResultSummaries: [],
				vaultRelativeReferences: [],
			},
		}))).toBe(false);
	});

	it("rebuilds a corrupt index from immutable manifests", async () => {
		const files = new MemoryFiles();
		const store = new PortableConversationStore(files);
		await store.create(manifest);
		files.files.set(".talos/agent-workbench/v1/index.json", "{broken");
		expect(await store.list()).toMatchObject([{ conversationId: "conv-1" }]);
	});

	it("supports archive, restore and recoverable soft delete", async () => {
		const store = new PortableConversationStore(new MemoryFiles());
		await store.create(manifest);
		await store.setLifecycle("conv-1", "archived");
		expect((await store.load("conv-1")).manifest.lifecycle).toBe("archived");
		await store.setLifecycle("conv-1", "deleted");
		expect((await store.load("conv-1")).manifest.lifecycle).toBe("deleted");
		await store.setLifecycle("conv-1", "active");
		expect((await store.load("conv-1")).manifest.lifecycle).toBe("active");
	});

	it("publishes updates through the adapter atomic-replace boundary", async () => {
		const files = new MemoryFiles();
		let replacements = 0;
		files.replace = async (from, to) => { replacements += 1; await files.rename(from, to); };
		const store = new PortableConversationStore(files);
		await store.create(manifest);
		await store.setLifecycle("conv-1", "archived");
		expect(replacements).toBeGreaterThanOrEqual(4);
		expect([...files.files.keys()].some((path) => path.endsWith(".tmp"))).toBe(false);
	});

	it("redacts secrets and local absolute paths at the storage boundary", async () => {
		const files = new MemoryFiles();
		const store = new PortableConversationStore(files);
		await store.create(manifest);
		await expect(store.append({ ...event(), payload: { authorization: "Bearer fake-secret-value" } })).resolves.toBe("written");
		await expect(store.append({ ...event("event-2"), payload: { text: "/synthetic/private.md" } })).resolves.toBe("written");
		const nestedRuntimeEvent = { ...event("event-3"), payload: { threadSettings: { collaborationMode: { settings: { developer_instructions: "read /etc/passwd now" } } } } };
		await expect(store.append(nestedRuntimeEvent)).resolves.toBe("written");
		await expect(store.append(nestedRuntimeEvent)).resolves.toBe("duplicate");
		const projection = await store.load("conv-1");
		expect(projection.events[0]?.payload).not.toHaveProperty("authorization");
		expect(JSON.stringify(projection.events)).not.toContain("/synthetic/private.md");
		expect(JSON.stringify(projection.events)).not.toContain("/etc/passwd");
		expect([...files.files.values()].join("\n")).not.toContain("fake-secret-value");
	});

	it("strips api key, credential and known token shapes from serialized bytes", () => {
		const serialized = JSON.stringify(sanitizePortableValue({
			apiKey: "AKIAIOSFODNN7EXAMPLE",
			accessKeyId: "AKIAIOSFODNN7EXAMPLE",
			credential: "cert-blob",
			secretAccessKey: "should-drop",
			githubToken: "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
		}));
		expect(serialized.includes("AKIAIOSFODNN7EXAMPLE")).toBe(false);
		expect(serialized.includes("cert-blob")).toBe(false);
		expect(serialized.includes("should-drop")).toBe(false);
		expect(serialized.includes("ghp_0123456789abcdefghijklmnopqrstuvwxyz")).toBe(false);
	});

	it("keeps api key shaped values out of the on-disk event bytes", async () => {
		const files = new MemoryFiles();
		const store = new PortableConversationStore(files);
		await store.create(manifest);
		await expect(store.append({
			...event("event-credentials"),
			payload: { apiKey: "AKIAIOSFODNN7EXAMPLE", credential: "cert-blob" },
		})).resolves.toBe("written");
		const bytes = [...files.files.values()].join("\n");
		expect(bytes.includes("AKIAIOSFODNN7EXAMPLE")).toBe(false);
		expect(bytes.includes("cert-blob")).toBe(false);
	});

	it("rejects a forbidden key on the assertion path", () => {
		expect(() => assertPortableValue({ apiKey: "AKIAIOSFODNN7EXAMPLE" })).toThrow("portable 数据包含禁止字段：apiKey");
		expect(() => assertPortableValue({ credential: "cert-blob" })).toThrow("portable 数据包含禁止字段：credential");
	});

	it.each([
		["polaris model id", "openai-codex/gpt-5.6-sol"],
		["markdown filename", "note.md"],
		["task id", "task-1234567890"],
		["short aws-like token", "AKIA-short"],
		["short github-like token", "ghp_short"],
	])("does not treat %s as a credential", (_label, value) => {
		expect(sanitizePortableString(value)).toBe(value);
		expect(() => assertPortableValue(value)).not.toThrow();
	});

	// 契约键防漂移：新增的丢弃集合必须为空（取数口径：src/agent-workbench/contracts/*.ts
	// 里形如 `name:` / `name?:` 的字段名 token）。清单硬编码在仓库内，不依赖外部探针。
	it("does not drop any additional contract field name", () => {
		const contractKeys = [
			"actionId", "args", "canonical", "canonicalToolId", "command", "content", "context", "control",
			"conversationId", "createdAt", "decision", "defaultReasoning", "defaultServiceTier", "description",
			"destructive", "displayName", "enabled", "enabledMcpServers", "endpoint", "eventId", "events",
			"executable", "executablePath", "executedToolIds", "externalContextPaths", "fetcher", "fromRuntimeId",
			"goal", "headerNames", "history", "historyRef", "id", "importedFrom", "incompleteTasks",
			"initialContext", "input", "isDefault", "kind", "label", "lastEventId", "lastSyncedEventId",
			"lastTurnId", "lifecycle", "linkedContent", "manifest", "model", "models", "nativeBindings",
			"nativeId", "nativeResumeToken", "network", "path", "payload", "permissionMode", "profile",
			"protocol", "protocolVersion", "providerProfileId", "providerStateRef", "raw", "reason", "reasonCode",
			"reasoning", "reasoningOptions", "recentMessages", "resolveSecret", "reviewOfTurnId", "risk", "role",
			"ruleId", "runId", "runtimeId", "sandboxNote", "schemaVersion", "secretRef", "security", "selection",
			"selections", "serviceTier", "serviceTiers", "session", "sessionId", "signal", "source", "sourceDigest",
			"status", "targets", "text", "timestamp", "title", "toRuntimeId", "toolPolicy", "toolResultSummaries",
			"tools", "toolsAllowed", "transcript", "turnId", "type", "updatedAt", "vaultRelativeReferences",
			"vaultRoot", "version", "workflow",
		];
		expect(contractKeys).toHaveLength(103);
		// 已丢弃集合 = 5 项既有敏感字段；新增丢弃集合必须为空（报告 A1 :168）。
		expect(contractKeys.filter((key) => FORBIDDEN_KEY.test(key)).sort()).toEqual([
			"executablePath", "nativeResumeToken", "resolveSecret", "secretRef", "vaultRoot",
		]);
		// 收窄后的 auth 分支不得把状态字面量/标识符卷进来。
		for (const safe of ["unauthenticated", "authority", "author"]) {
			expect(FORBIDDEN_KEY.test(safe)).toBe(false);
		}
		for (const sensitive of ["apiKey", "api_key", "API-KEY", "accessKeyId", "access_key", "credential", "credentials", "authToken", "auth", "auth_header", "x-auth"]) {
			expect(FORBIDDEN_KEY.test(sensitive)).toBe(true);
		}
	});

	const syntheticMacPath = ["", "Users", "synthetic", "超级大脑", "state.json"].join("/");
	const markdownWrappedMacPath = ["`", syntheticMacPath, "`"].join("");

	it.each([
		["Windows drive root with backslash", "C:\\"],
		["Windows drive root with slash", "C:/"],
		["UNC share root", "\\\\server\\share"],
		["Markdown-wrapped Unicode POSIX path", markdownWrappedMacPath],
		["Windows root-relative", "\\synthetic-home\\project\\x.md"],
	])("keeps portable detection and redaction symmetric for %s", (_label, value) => {
		expect(() => assertPortableValue(value)).toThrow("portable 数据不得包含本机绝对路径");
		const portable = sanitizePortableString(value);
		expect(portable).not.toBe(value);
		expect(portable.includes("synthetic-home")).toBe(false);
		expect(JSON.stringify(sanitizePortableValue({ nativeId: value })).includes("synthetic-home")).toBe(false);
		expect(() => assertPortableValue(portable)).not.toThrow();
	});

	it.each([
		["HTTPS URL", "https://api.openai.com/v1"],
		["embedded drive-like text", "abcC:\\runtime\\state.json"],
		["bare escaped slashes", "\\\\"],
		["model id", "openai-codex/gpt-5.6-sol"],
	])("does not mistake %s for a local absolute path", (_label, value) => {
		expect(sanitizePortableString(value)).toBe(value);
		expect(() => assertPortableValue(value)).not.toThrow();
	});

	// 误报护栏：Windows 单反斜杠判定必须放过用户正文。v4 形态会把其中 8 条吞成
	// 「[本机路径已省略]」（报告 A1 实测），这里逐条钉死「原样返回」。
	it.each([
		["escaped bold markers", "\\*\\*bold\\*\\*"],
		["markdown bold", "**bold**"],
		["escaped starred word", "note \\*starred\\* text"],
		["plain starred word", "note *starred* text"],
		["regex shorthand backslashes", "regex \\d+\\w+ pattern"],
		["latex greek letters", "latex \\alpha\\beta"],
		["latex sqrt", "math \\sqrt\\pi"],
		["regex shorthand classes", "regex \\w+\\s"],
		["latex fraction", "latex \\frac{1}{2}"],
		["escape sequence n", "escape \\n"],
		["latex left right", "latex \\left(\\right)"],
		["unicode escape", "escape \\u00e9"],
		["regex dotted range", "regex \\d{1,3}\\."],
	])("keeps user prose untouched: %s", (_label, value) => {
		expect(sanitizePortableString(value)).toBe(value);
		expect(() => assertPortableValue(value)).not.toThrow();
	});

	// RuntimeId 契约已收窄为 "ohmypi"；历史 runtime 名仍会从旧会话 JSON 读回，
	// 因此这里用 legacyRuntime 作为**载荷内容**（而不是类型化的 runtimeId 字段）
	// 覆盖「旧名 + 本机路径元数据」同时出现时不影响可移植 append。
	it.each(["claude", "codex", "ohmypi"] as const)(
		"keeps %s native path metadata from aborting the shared portable append",
		async (legacyRuntime) => {
			const files = new MemoryFiles();
			const store = new PortableConversationStore(files);
			await store.create(manifest);
			await expect(store.append({
				...event("event-" + legacyRuntime),
				payload: {
					legacyRuntime,
					driveRoot: "C:\\",
					uncRoot: "\\\\server\\share",
					instruction: markdownWrappedMacPath,
				},
			})).resolves.toBe("written");
			const projection = await store.load("conv-1");
			expect(() => assertPortableValue(projection.events)).not.toThrow();
		},
	);

	it("keeps a portable policy rejection from interrupting the runtime", async () => {
		const appended: unknown[] = [];
		let rejectPolicy = true;
		const store = {
			append: async (value: unknown) => {
				appended.push(value);
				if (rejectPolicy) {
					rejectPolicy = false;
					throw new Error("portable 数据不得包含本机绝对路径");
				}
				return "written" as const;
			},
		} as unknown as PortableConversationStore;
		const coordinator = new WorkbenchConversationCoordinator(
			new ConversationService(store),
			new RuntimeBindingStore({
				read: async () => null,
				write: async () => undefined,
			}),
		);
		const result = await coordinator.appendRuntimeEvent("conv-1", event("native-policy-event"), "");
		expect(result).toMatchObject({
			type: "notice",
			payload: { omittedEventType: "assistant.final" },
		});
		expect(appended).toHaveLength(2);
		expect(appended[1]).toEqual(result);
	});

	it("orders conversations by durable user activity instead of creation time", async () => {
		const store = new PortableConversationStore(new MemoryFiles());
		await store.create(manifest);
		await store.create({ ...manifest, conversationId: "conv-2", updatedAt: "2026-08-26T00:00:02.000Z" });
		const conversations = new ConversationService(store, {
			now: () => "2026-08-26T00:00:03.000Z",
			id: () => "generated-event",
		});
		await conversations.append({
			conversationId: "conv-1",
			turnId: "turn-activity",
			runtimeId: "ohmypi",
			type: "user.message",
			payload: { text: "new activity" },
		});
		expect((await store.list()).map((item) => item.conversationId)).toEqual(["conv-1", "conv-2"]);
		expect((await store.load("conv-1")).manifest.updatedAt).toBe("2026-08-26T00:00:03.000Z");
	});
});

describe("RuntimeBindingStore transaction queue", () => {
	/** 每次 read/write 各加 20ms 延迟，用来放大「无锁 read→write」的重叠窗口。 */
	function delayedHost(initial: Record<string, unknown> | null = null) {
		let persisted = initial;
		const host = {
			persisted: () => persisted,
			reads: 0,
			writes: 0,
			async read() {
				host.reads += 1;
				await new Promise((resolve) => setTimeout(resolve, 20));
				return persisted;
			},
			async write(value: Record<string, unknown>) {
				host.writes += 1;
				await new Promise((resolve) => setTimeout(resolve, 20));
				persisted = structuredClone(value);
			},
		};
		return host;
	}

	it("keeps both bindings when two conversation ids set concurrently", async () => {
		const host = delayedHost();
		const store = new RuntimeBindingStore(host);
		await Promise.all([
			store.set("conv-A", { runtimeId: "ohmypi", sessionId: "session-A" }),
			store.set("conv-B", { runtimeId: "ohmypi", sessionId: "session-B" }),
		]);

		const persistedBindings = (host.persisted()?.bindings ?? {}) as Record<string, unknown>;
		const keys = Object.keys(persistedBindings);
		expect(keys).toHaveLength(2);
		expect(keys).toEqual(expect.arrayContaining(["conv-A:ohmypi:native", "conv-B:ohmypi:native"]));
		expect(await store.get("conv-A", "ohmypi")).toMatchObject({ sessionId: "session-A" });
		expect(await store.get("conv-B", "ohmypi")).toMatchObject({ sessionId: "session-B" });
	});

	it("does not write when the binding to remove never existed", async () => {
		const host = delayedHost();
		const store = new RuntimeBindingStore(host);
		await store.remove("conv-missing", "ohmypi");
		expect(host.writes).toBe(0);
		expect(host.persisted()).toBeNull();
	});

	it("writes exactly once when an existing binding is removed", async () => {
		const host = delayedHost();
		const store = new RuntimeBindingStore(host);
		await store.set("conv-A", { runtimeId: "ohmypi", sessionId: "session-A" });
		const writesAfterSet = host.writes;
		await store.remove("conv-A", "ohmypi");
		expect(host.writes).toBe(writesAfterSet + 1);
		expect(await store.get("conv-A", "ohmypi")).toBeNull();
	});
});

describe("PortableConversationStore manifest lock", () => {
	/**
	 * 把「武装后第一次」读 manifest 卡住，直到放开闸门，用来构造确定性的交错。
	 * 必须在 create 之后才 arm：索引首次缺失时 readIndex 会回退 rebuildIndex，
	 * 那时也会读 manifest，提前武装会把 create 本身卡死（不是被测行为）。
	 */
	function gatedFiles() {
		const files = new MemoryFiles();
		const manifestRead = ".talos/agent-workbench/v1/conversations/conv-1/manifest.json";
		let armGate: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => { armGate = resolve; });
		let armed = false;
		let held = false;
		const original = files.read.bind(files);
		files.read = async (path: string) => {
			if (armed && !held && path === manifestRead) {
				held = true;
				await gate;
			}
			return original(path);
		};
		return { files, arm: () => { armed = true; }, release: () => armGate() };
	}

	it("keeps archived lifecycle when touch and setLifecycle interleave", async () => {
		const { files, arm, release } = gatedFiles();
		const store = new PortableConversationStore(files);
		await store.create(manifest);

		arm();
		const touch = store.touch("conv-1", "2026-08-26T00:00:05.000Z");
		const archived = store.setLifecycle("conv-1", "archived");
		release();
		const settled = await Promise.allSettled([touch, archived]);
		expect(settled.map((item) => item.status)).toEqual(["fulfilled", "fulfilled"]);

		expect((await store.load("conv-1")).manifest.lifecycle).toBe("archived");
		const index = JSON.parse(files.files.get(".talos/agent-workbench/v1/index.json") ?? "{}") as {
			conversations: Record<string, { lifecycle: string }>;
		};
		expect(index.conversations["conv-1"]?.lifecycle).toBe("archived");
	});
});

