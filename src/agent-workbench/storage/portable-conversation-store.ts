import { createHash } from "node:crypto";
import type { AgentEvent } from "../contracts/agent-events";
import type { ConversationManifest, ConversationProjection } from "../contracts/conversation";

export interface PortableFileAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, value: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	/** Atomically replaces `to` with `from` on the same filesystem. */
	replace(from: string, to: string): Promise<void>;
	remove(path: string): Promise<void>;
	rmdir?(path: string, recursive: boolean): Promise<void>;
	mkdir(path: string): Promise<void>;
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
	flush?(): Promise<void>;
}

interface PortableIndex {
	schemaVersion: 1;
	conversations: Record<string, ConversationManifest>;
}

const ROOT = ".talos/agent-workbench/v1";
const INDEX = `${ROOT}/index.json`;
const FORBIDDEN_KEY = /(?:secret|token|password|authorization|cookie|executablePath|vaultRoot)/i;
// Detection and redaction must be built from the same sources. A wider assertion
// than sanitizer turns harmless native runtime metadata into a connection error.
const POSIX_ABSOLUTE_SOURCE = String.raw`(^|[\s("'=:[{,<\x60])\/(?!\/)[^\s/"'<>)}\],]+(?:\/[^\s/"'<>)}\],]+)+`;
const WINDOWS_ABSOLUTE_SOURCE = String.raw`\b[A-Za-z]:[\\\/][^\s"'<>)}\]]*`;
const WINDOWS_UNC_SOURCE = String.raw`\\\\[^\\/\s"'<>)}\]]+[\\/][^\\/\s"'<>)}\]]+(?:[\\/][^\s"'<>)}\]]*)?`;
const ABSOLUTE_PATH = new RegExp(`(?:${POSIX_ABSOLUTE_SOURCE}|${WINDOWS_ABSOLUTE_SOURCE}|${WINDOWS_UNC_SOURCE})`);
const POSIX_ABSOLUTE = new RegExp(POSIX_ABSOLUTE_SOURCE, "g");
const WINDOWS_ABSOLUTE = new RegExp(WINDOWS_ABSOLUTE_SOURCE, "g");
const WINDOWS_UNC = new RegExp(WINDOWS_UNC_SOURCE, "g");
const SECRET = /\b(?:bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]{12,})\b/gi;

function stableJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

export function assertPortableValue(value: unknown, key = ""): void {
	if (FORBIDDEN_KEY.test(key)) throw new Error(`portable 数据包含禁止字段：${key}`);
	if (typeof value === "string") {
		if (ABSOLUTE_PATH.test(value)) throw new Error("portable 数据不得包含本机绝对路径");
		if (/\b(?:bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]{12,})\b/i.test(value)) {
			throw new Error("portable 数据不得包含凭据");
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) assertPortableValue(item, key);
		return;
	}
	if (value && typeof value === "object") {
		for (const [childKey, child] of Object.entries(value)) {
			assertPortableValue(child, childKey);
		}
	}
}

export function sanitizePortableString(value: string, vaultRoot = ""): string {
	let result = value;
	const normalizedRoot = vaultRoot.replace(/\\/g, "/").replace(/\/$/, "");
	if (normalizedRoot) {
		result = result.split(normalizedRoot).join(".");
		result = result.split(normalizedRoot.replace(/\//g, "\\")).join(".");
	}
	result = result.replace(SECRET, "[凭据已省略]");
	result = result.replace(POSIX_ABSOLUTE, (_match, prefix: string) => prefix + "[本机路径已省略]");
	result = result.replace(WINDOWS_ABSOLUTE, "[本机路径已省略]");
	result = result.replace(WINDOWS_UNC, "[本机路径已省略]");
	return result;
}

export function sanitizePortableValue(value: unknown, vaultRoot = ""): unknown {
	if (typeof value === "string") return sanitizePortableString(value, vaultRoot);
	if (Array.isArray(value)) return value.map((item) => sanitizePortableValue(item, vaultRoot));
	if (!value || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (FORBIDDEN_KEY.test(key)) continue;
		result[key] = sanitizePortableValue(child, vaultRoot);
	}
	return result;
}

function safeConversationId(id: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new Error("conversationId 不是安全路径段");
	return id;
}
function manifestPath(id: string): string { return `${ROOT}/conversations/${safeConversationId(id)}/manifest.json`; }
function conversationPath(id: string): string { return `${ROOT}/conversations/${safeConversationId(id)}`; }
function eventsPath(id: string): string { return `${ROOT}/conversations/${safeConversationId(id)}/events`; }
function eventPath(id: string, eventId: string): string {
	if (!eventId || eventId.length > 512) throw new Error("eventId 无效");
	const digest = createHash("sha256").update(eventId).digest("hex");
	return `${eventsPath(id)}/${digest}.json`;
}

function eventPriority(event: AgentEvent): number {
	if (event.type === "user.message") return 0;
	if (event.type === "assistant.start") return 1;
	return 2;
}

function orderEvents(events: AgentEvent[]): void {
	const turnAnchors = new Map<string, string>();
	for (const event of events) {
		const candidate = `${event.timestamp}\u0000${event.eventId}`;
		const current = turnAnchors.get(event.turnId);
		if (!current || candidate < current) turnAnchors.set(event.turnId, candidate);
	}
	events.sort((left, right) => (turnAnchors.get(left.turnId) ?? "").localeCompare(turnAnchors.get(right.turnId) ?? "")
		|| eventPriority(left) - eventPriority(right)
		|| left.timestamp.localeCompare(right.timestamp)
		|| left.eventId.localeCompare(right.eventId));
}

export class PortableConversationStore {
	/**
	 * 索引写队列:read-modify-write 必须串行,否则并发 touch/updateManifest 会
	 * 各自读到旧快照并互相覆盖(丢失更新)。原全量重建实现不受影响,改为
	 * 单条维护后必须显式串行化。
	 */
	private indexWriteQueue: Promise<unknown> = Promise.resolve();

	private withIndexLock<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.indexWriteQueue.then(operation, operation);
		this.indexWriteQueue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	constructor(private readonly files: PortableFileAdapter) {}

	private async ensure(path: string): Promise<void> {
		const parts = path.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(await this.files.exists(current))) await this.files.mkdir(current);
		}
	}

	private async atomicWrite(path: string, value: unknown): Promise<void> {
		const portable = sanitizePortableValue(value);
		assertPortableValue(portable);
		const slash = path.lastIndexOf("/");
		if (slash > 0) await this.ensure(path.slice(0, slash));
		const temporary = `${path}.tmp`;
		await this.files.write(temporary, stableJson(portable));
		await this.files.flush?.();
		await this.files.replace(temporary, path);
	}

	private async removeEmptyDirectory(path: string): Promise<void> {
		if (!(await this.files.exists(path))) return;
		if (!this.files.rmdir) throw new Error("工作台存储不支持安全空目录删除");
		await this.files.rmdir(path, false);
	}

	async create(manifest: ConversationManifest): Promise<void> {
		if (await this.files.exists(manifestPath(manifest.conversationId))) {
			throw new Error("会话已存在");
		}
		await this.atomicWrite(manifestPath(manifest.conversationId), manifest);
		await this.ensure(eventsPath(manifest.conversationId));
		await this.upsertIndexEntry(manifest);
	}

	async updateManifest(manifest: ConversationManifest): Promise<void> {
		await this.atomicWrite(manifestPath(manifest.conversationId), manifest);
		await this.upsertIndexEntry(manifest);
	}

	async touch(conversationId: string, timestamp: string): Promise<void> {
		const manifest = JSON.parse(await this.files.read(manifestPath(conversationId))) as ConversationManifest;
		if (manifest.updatedAt >= timestamp) return;
		await this.updateManifest({
			...manifest,
			updatedAt: timestamp,
		});
	}

	async append(event: AgentEvent): Promise<"written" | "duplicate"> {
		const portable = sanitizePortableValue(event) as AgentEvent;
		const path = eventPath(portable.conversationId, portable.eventId);
		if (await this.files.exists(path)) {
			const existing = sanitizePortableValue(JSON.parse(await this.files.read(path))) as AgentEvent;
			if (stableJson(existing) !== stableJson(portable)) throw new Error("eventId 内容冲突");
			return "duplicate";
		}
		await this.atomicWrite(path, portable);
		return "written";
	}

	async load(conversationId: string): Promise<ConversationProjection> {
		const manifest = JSON.parse(await this.files.read(manifestPath(conversationId))) as ConversationManifest;
		const listing = await this.files.list(eventsPath(conversationId));
		const events: AgentEvent[] = [];
		for (const file of listing.files.filter((name) => name.endsWith(".json")).sort()) {
			events.push(JSON.parse(await this.files.read(`${eventsPath(conversationId)}/${file}`)) as AgentEvent);
		}
		orderEvents(events);
		return {
			manifest,
			events,
			lastEventId: events.at(-1)?.eventId,
			lastTurnId: events.at(-1)?.turnId,
			nativeBindings: {},
		};
	}

	async discardEmpty(conversationId: string): Promise<boolean> {
		const projection = await this.load(conversationId);
		if (
			projection.manifest.lifecycle !== "active"
			|| projection.manifest.title !== "新会话"
			|| projection.manifest.importedFrom
			|| projection.events.length > 0
		) return false;
		const listing = await this.files.list(eventsPath(conversationId));
		if (listing.files.length > 0 || listing.folders.length > 0) return false;
		const conversationListing = await this.files.list(conversationPath(conversationId));
		if (
			conversationListing.files.some((name) => name !== "manifest.json")
			|| conversationListing.folders.some((name) => name !== "events")
		) return false;
		await this.removeEmptyDirectory(eventsPath(conversationId));
		await this.files.remove(manifestPath(conversationId));
		await this.removeEmptyDirectory(conversationPath(conversationId));
		await this.removeIndexEntry(conversationId);
		return true;
	}

	/** 读取现有索引;损坏或缺失时回退一次全量重建(索引文件本身即缓存)。 */
	private async readIndex(): Promise<PortableIndex> {
		try {
			const index = JSON.parse(await this.files.read(INDEX)) as PortableIndex;
			if (index.schemaVersion !== 1 || !index.conversations) throw new Error("index schema");
			return index;
		} catch {
			return await this.rebuildIndex();
		}
	}

	// P2:写路径改为索引单条维护——O(1) 读改写,替代原先每次 O(会话数) 的目录扫描。
	private upsertIndexEntry(manifest: ConversationManifest): Promise<void> {
		return this.withIndexLock(async () => {
			const index = await this.readIndex();
			index.conversations[manifest.conversationId] = manifest;
			await this.writeIndex(index);
		});
	}

	private removeIndexEntry(conversationId: string): Promise<void> {
		return this.withIndexLock(async () => {
			const index = await this.readIndex();
			delete index.conversations[conversationId];
			await this.writeIndex(index);
		});
	}

	async rebuildIndex(): Promise<PortableIndex> {
		const index: PortableIndex = { schemaVersion: 1, conversations: {} };
		const root = `${ROOT}/conversations`;
		if (!(await this.files.exists(root))) return index;
		const listing = await this.files.list(root);
		for (const id of listing.folders.sort()) {
			const path = manifestPath(id);
			if (!(await this.files.exists(path))) continue;
			try {
				const manifest = JSON.parse(await this.files.read(path)) as ConversationManifest;
				index.conversations[manifest.conversationId] = manifest;
			} catch {
				// A corrupt conversation remains on disk for recovery, but is not indexed.
			}
		}
		return index;
	}

	async list(): Promise<ConversationManifest[]> {
		let index = await this.readIndex();
		return Object.values(index.conversations).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async setLifecycle(id: string, lifecycle: ConversationManifest["lifecycle"]): Promise<void> {
		const projection = await this.load(id);
		await this.updateManifest({
			...projection.manifest,
			lifecycle,
			updatedAt: new Date().toISOString(),
		});
	}

	private async writeIndex(index: PortableIndex): Promise<void> {
		await this.atomicWrite(INDEX, index);
	}
}
