export interface WorkbenchUiState {
	schemaVersion: 1;
	openConversationIds: string[];
	activeConversationId?: string;
	historyOpen: boolean;
}

export interface WorkbenchUiStateAdapter {
	read(): Promise<unknown>;
	write(value: WorkbenchUiState): Promise<void>;
}

const DEFAULT_STATE: WorkbenchUiState = {
	schemaVersion: 1,
	openConversationIds: [],
	historyOpen: false,
};

function normalize(value: unknown): WorkbenchUiState {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_STATE };
	const record = value as Record<string, unknown>;
	const openConversationIds = Array.isArray(record.openConversationIds)
		? [...new Set(record.openConversationIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())))]
		: [];
	return {
		schemaVersion: 1,
		openConversationIds,
		...(typeof record.activeConversationId === "string" ? { activeConversationId: record.activeConversationId } : {}),
		historyOpen: record.historyOpen === true,
	};
}

/** One-way projection of the retired tab sidecar into native conversation ids. */
export function migrateLegacyTabManagerState(tabState: unknown, importState: unknown): WorkbenchUiState | null {
	if (!tabState || typeof tabState !== "object" || Array.isArray(tabState)) return null;
	if (!importState || typeof importState !== "object" || Array.isArray(importState)) return null;
	const tabsRecord = tabState as Record<string, unknown>;
	const importRecord = importState as Record<string, unknown>;
	const imports = importRecord.imports && typeof importRecord.imports === "object" && !Array.isArray(importRecord.imports)
		? importRecord.imports as Record<string, unknown>
		: {};
	const legacyToNative = new Map<string, string>();
	for (const value of Object.values(imports)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const entry = value as Record<string, unknown>;
		if (typeof entry.legacyConversationId === "string" && typeof entry.conversationId === "string") {
			legacyToNative.set(entry.legacyConversationId, entry.conversationId);
		}
	}
	const tabs = Array.isArray(tabsRecord.openTabs) ? tabsRecord.openTabs : [];
	const byTabId = new Map<string, string>();
	const openConversationIds: string[] = [];
	for (const value of tabs) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const tab = value as Record<string, unknown>;
		if (typeof tab.conversationId !== "string") continue;
		const nativeId = legacyToNative.get(tab.conversationId);
		if (!nativeId) continue;
		if (!openConversationIds.includes(nativeId)) openConversationIds.push(nativeId);
		if (typeof tab.tabId === "string") byTabId.set(tab.tabId, nativeId);
	}
	if (!openConversationIds.length) return null;
	const activeConversationId = typeof tabsRecord.activeTabId === "string"
		? byTabId.get(tabsRecord.activeTabId)
		: undefined;
	return {
		schemaVersion: 1,
		openConversationIds,
		...(activeConversationId ? { activeConversationId } : {}),
		historyOpen: false,
	};
}

/** Durable, TALOS-owned tab and history-panel state. */
export class WorkbenchUiStateStore {
	private tail = Promise.resolve();

	constructor(private readonly adapter: WorkbenchUiStateAdapter) {}

	async load(): Promise<WorkbenchUiState | null> {
		// this.tail 只用来等队列排空，本身不会 reject（见 save 的吞异常分支）；
		// 下面 adapter.read() 的失败必须原样上抛，不能吞成 null——null 的语义是「从未保存过」。
		await this.tail;
		const raw = await this.adapter.read();
		// null/undefined = 从未保存过标签状态（首次运行）；
		// 已保存过的空数组必须原样返回——它代表「用户主动关掉了全部标签」，
		// 恢复逻辑不得把它当成缺失而回退重开最近会话。
		if (raw === null || raw === undefined) return null;
		return normalize(raw);
	}

	save(value: WorkbenchUiState): Promise<void> {
		const next = normalize(value);
		// 与 conversation-input-ledger.ts 的事务模板同构：队列尾部赋成吞掉异常的 promise，
		// 单次写失败只让这一次 save 的返回值 reject，不再毒化后续 save 与 load。
		const operation = this.tail.then(() => this.adapter.write(next));
		this.tail = operation.then(() => undefined, () => undefined);
		return operation;
	}
}
