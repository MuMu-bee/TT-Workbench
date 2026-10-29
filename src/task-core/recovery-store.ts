import type { TalosTaskState } from "./types";

export interface RecoveryCaptureInput {
	taskId: string;
	actionId: string;
	targetPaths: string[];
	createdAt: string;
}

export interface RecoveryRecord extends RecoveryCaptureInput {
	id: string;
}

export interface RecoveryStore {
	capture(input: RecoveryCaptureInput): Promise<string>;
	has?(id: string): boolean;
	restore?(id: string): Promise<void>;
	/**
	 * 可选：注入「任务当前状态」查询。有上限的实现（`VaultRecoveryStore`）靠它判断
	 * 哪些快照已终结、可以淘汰；无上限的实现不必实现。
	 */
	setTaskStateResolver?(resolver: RecoveryTaskStateResolver): void;
}

export class MemoryRecoveryStore implements RecoveryStore {
	private readonly records = new Map<string, RecoveryRecord>();
	private sequence = 0;

	constructor(
		private readonly onCapture?: (record: RecoveryRecord) => void,
		private readonly onRestore?: (record: RecoveryRecord) => void
	) {}

	async capture(input: RecoveryCaptureInput): Promise<string> {
		this.sequence++;
		const id = `recovery-${input.taskId}-${this.sequence}`;
		const record: RecoveryRecord = {
			id,
			taskId: input.taskId,
			actionId: input.actionId,
			targetPaths: [...input.targetPaths],
			createdAt: input.createdAt,
		};
		this.records.set(id, record);
		this.onCapture?.(record);
		return id;
	}

	get(id: string): RecoveryRecord | undefined {
		return this.records.get(id);
	}

	has(id: string): boolean {
		return this.records.has(id);
	}

	async restore(id: string): Promise<void> {
		const record = this.records.get(id);
		if (!record) throw new Error(`未找到恢复点：${id}`);
		this.onRestore?.(record);
	}
}

export interface RecoveryFileAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, value: string): Promise<void>;
	remove(path: string): Promise<void>;
}

interface VaultRecoverySnapshot {
	record: RecoveryRecord;
	files: Array<{
		path: string;
		existed: boolean;
		content?: string;
	}>;
}

/**
 * 任务状态来源。快照淘汰只允许落在**已终结**任务的快照上：
 * `task-runner.ts:196` 的 `transition(..., "running", { recoveryId })` 是快照被真正
 * 使用的时点，之后 revert 随时可能 restore，所以 ready/queued/running 都不许淘汰。
 */
export type RecoveryTaskStateResolver = (
	taskId: string
) => TalosTaskState | undefined;

/** 已终结状态：这些任务的快照不会再被 revert 需要，淘汰不会把「可恢复」变成抛错。 */
const TERMINAL_TASK_STATES: ReadonlySet<TalosTaskState> = new Set([
	"completed",
	"partial",
	"failed",
	"cancelled",
	"reverted",
]);

function recoveryPath(path: string): string {
	const normalized = path.trim().replace(/\\/g, "/");
	if (!normalized || (normalized.startsWith("<") && normalized.endsWith(">"))) {
		return normalized;
	}
	const segments = normalized.split("/");
	if (
		normalized.startsWith("/") ||
		/^[a-zA-Z]:\//.test(normalized) ||
		normalized.includes("\0") ||
		segments.some(
			(segment, index) =>
				segment === "." ||
				segment === ".." ||
				(segment === "" && index > 0)
		)
	) {
		throw new Error(`RecoveryStore 禁止不安全路径：${normalized}`);
	}
	return normalized;
}

export class VaultRecoveryStore implements RecoveryStore {
	/**
	 * 快照驻留条数上限（Q-PER5）。报告未给出具体值，取与
	 * `MAX_PENDING_PROPOSALS` 同量级的 64，使长会话内存不再单调上升。
	 */
	private readonly maxSnapshots = 64;
	private readonly snapshots = new Map<string, VaultRecoverySnapshot>();
	private sequence = 0;
	/** 已淘汰条数，只读计数供验收断言。 */
	private evicted = 0;
	private taskStateResolver?: RecoveryTaskStateResolver;

	constructor(private readonly adapter: RecoveryFileAdapter) {}

	/**
	 * 注入任务状态查询。本类不持有 task store，而淘汰只允许落在已终结任务上，
	 * 因此由外部提供状态；未注入时所有任务都按「状态未知」处理——宁可保持超限，
	 * 也不淘汰可能仍被 revert 需要的快照。
	 */
	setTaskStateResolver(resolver: RecoveryTaskStateResolver): void {
		this.taskStateResolver = resolver;
	}

	/** 已淘汰的快照条数（只读，供验收与观测使用）。 */
	evictedCount(): number {
		return this.evicted;
	}

	async capture(input: RecoveryCaptureInput): Promise<string> {
		const paths = input.targetPaths.map(recoveryPath);
		const privatePath = paths.find(
			(path) => {
				const lower = path.toLowerCase();
				return (
					lower === ".talos/private" ||
					lower.startsWith(".talos/private/")
				);
			}
		);
		if (privatePath) {
			throw new Error(`RecoveryStore 禁止读取 private 路径：${privatePath}`);
		}
		this.sequence++;
		const id = `recovery-${input.taskId}-${this.sequence}`;
		const record: RecoveryRecord = {
			id,
			taskId: input.taskId,
			actionId: input.actionId,
			targetPaths: [...input.targetPaths],
			createdAt: input.createdAt,
		};
		const files: VaultRecoverySnapshot["files"] = [];
		for (const path of paths) {
			if (!path || (path.startsWith("<") && path.endsWith(">"))) continue;
			const existed = await this.adapter.exists(path);
			files.push({
				path,
				existed,
				content: existed ? await this.adapter.read(path) : undefined,
			});
		}
		this.snapshots.set(id, { record, files });
		this.evictIfNeeded();
		return id;
	}

	/**
	 * 超出上限时按插入序（最旧优先）淘汰**已终结**任务的快照。
	 * 仍 running/queued/ready 的任务的快照一律跳过——淘汰它会把「可恢复」变成
	 * `restore()` 抛「未找到恢复点」。一条都不可淘汰时保持超限并告警，不抛错，
	 * 避免把正常 capture 打挂。
	 */
	private evictIfNeeded(): void {
		while (this.snapshots.size > this.maxSnapshots) {
			const victim = this.oldestEvictableId();
			if (victim === undefined) {
				console.warn(
					`RecoveryStore 快照数 ${this.snapshots.size} 超过上限 ${this.maxSnapshots}，` +
						"但最旧的快照都还属于未终结任务，暂不淘汰"
				);
				return;
			}
			this.snapshots.delete(victim);
			this.evicted++;
		}
	}

	/** 从头（最旧）开始找第一条可淘汰的快照；找不到返回 undefined。 */
	private oldestEvictableId(): string | undefined {
		for (const [id, snapshot] of this.snapshots) {
			if (this.isTerminalTask(snapshot.record.taskId)) return id;
		}
		return undefined;
	}

	/**
	 * 状态未知（未注入 resolver 或任务不在 store 里）一律按「未终结」处理：
	 * 宁可保持超限，也不冒把还可 revert 的快照删掉的风险。
	 */
	private isTerminalTask(taskId: string): boolean {
		const state = this.taskStateResolver?.(taskId);
		return state !== undefined && TERMINAL_TASK_STATES.has(state);
	}

	has(id: string): boolean {
		return this.snapshots.has(id);
	}

	async restore(id: string): Promise<void> {
		const snapshot = this.snapshots.get(id);
		if (!snapshot) throw new Error(`未找到恢复点：${id}`);
		for (const file of [...snapshot.files].reverse()) {
			if (file.existed) {
				await this.adapter.write(file.path, file.content ?? "");
				continue;
			}
			if (await this.adapter.exists(file.path)) {
				await this.adapter.remove(file.path);
			}
		}
	}
}
