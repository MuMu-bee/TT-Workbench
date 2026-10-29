import type { TalosTaskRun, TalosTaskState } from "./types";

type TaskPatch = Partial<Omit<TalosTaskRun, "id" | "state">>;
type TaskSubscriber = (task: TalosTaskRun) => void;

const TRANSITIONS: Readonly<Record<TalosTaskState, readonly TalosTaskState[]>> = {
	ready: ["queued", "cancelled"],
	queued: ["running", "failed", "cancelled"],
	running: ["completed", "partial", "failed", "cancelled"],
	completed: ["reverted"],
	partial: ["reverted"],
	failed: ["reverted"],
	cancelled: [],
	reverted: [],
};

export class MemoryTaskStore {
	private readonly tasks = new Map<string, TalosTaskRun>();
	/**
	 * `idempotencyKey → id` 索引：让 `findByIdempotencyKey` 不再线性扫全表。
	 * 本类没有删除方法，所以索引不会悬挂；若日后加删除，必须同步删索引。
	 * 两条写路径（`create` / `transition`）都必须保持它与 `tasks` 一致。
	 */
	private readonly idByKey = new Map<string, string>();
	private readonly subscribers = new Set<TaskSubscriber>();

	constructor(initial: TalosTaskRun[] = []) {
		for (const task of initial) this.create(task);
	}

	create(task: TalosTaskRun): TalosTaskRun {
		if (this.tasks.has(task.id)) throw new Error(`重复任务 ID：${task.id}`);
		if (this.findByIdempotencyKey(task.idempotencyKey)) {
			throw new Error(`重复幂等键：${task.idempotencyKey}`);
		}
		this.tasks.set(task.id, task);
		this.idByKey.set(task.idempotencyKey, task.id);
		this.notify(task);
		return task;
	}

	get(id: string): TalosTaskRun | undefined {
		return this.tasks.get(id);
	}

	findByIdempotencyKey(key: string): TalosTaskRun | undefined {
		const id = this.idByKey.get(key);
		return id === undefined ? undefined : this.tasks.get(id);
	}

	list(): readonly TalosTaskRun[] {
		return Object.freeze(Array.from(this.tasks.values()));
	}

	transition(
		id: string,
		nextState: TalosTaskState,
		patch: TaskPatch = {}
	): TalosTaskRun {
		const current = this.tasks.get(id);
		if (!current) throw new Error(`未找到任务：${id}`);
		if (!TRANSITIONS[current.state].includes(nextState)) {
			throw new Error(`非法任务状态转换：${current.state} → ${nextState}`);
		}
		const next: TalosTaskRun = { ...current, ...patch, state: nextState };
		// `TaskPatch` 只 Omit 掉 id 与 state，patch 仍可能改到 idempotencyKey；
		// 索引必须在这里同步，否则改键后查重会漏（transition 不改 id，tasks 的键不动）。
		if (next.idempotencyKey !== current.idempotencyKey) {
			this.idByKey.delete(current.idempotencyKey);
			this.idByKey.set(next.idempotencyKey, id);
		}
		this.tasks.set(id, next);
		this.notify(next);
		return next;
	}

	subscribe(subscriber: TaskSubscriber): () => void {
		this.subscribers.add(subscriber);
		return () => this.subscribers.delete(subscriber);
	}

	private notify(task: TalosTaskRun): void {
		for (const subscriber of this.subscribers) subscriber(task);
	}
}
