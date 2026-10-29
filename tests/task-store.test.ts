import { describe, expect, it } from "vitest";
import { MemoryTaskStore } from "../src/task-core/task-store";
import type { TalosTaskRun } from "../src/task-core/types";

function run(overrides: Partial<TalosTaskRun> = {}): TalosTaskRun {
	return {
		id: "task-1",
		idempotencyKey: "idem-1",
		actionId: "refresh-stats",
		state: "ready",
		approvalRequired: false,
		readPaths: [],
		changes: [],
		createdAt: "2026-07-24T00:00:00.000Z",
		...overrides,
	};
}

describe("MemoryTaskStore", () => {
	it("persists legal task transitions and notifies subscribers", () => {
		const store = new MemoryTaskStore();
		const observed: string[] = [];
		store.subscribe((task) => observed.push(task.state));

		store.create(run());
		store.transition("task-1", "queued");
		store.transition("task-1", "running");
		store.transition("task-1", "completed", {
			finishedAt: "2026-07-24T00:00:01.000Z",
		});

		expect(store.get("task-1")?.state).toBe("completed");
		expect(observed).toEqual(["ready", "queued", "running", "completed"]);
	});

	it("rejects an illegal terminal-to-running transition", () => {
		const store = new MemoryTaskStore([
			run({ state: "completed", finishedAt: "2026-07-24T00:00:01.000Z" }),
		]);

		expect(() => store.transition("task-1", "running")).toThrow(
			/非法任务状态转换/
		);
	});

	it("requires a new task ID for retries", () => {
		const store = new MemoryTaskStore([
			run({ state: "failed", error: "provider failed" }),
		]);

		expect(() => store.transition("task-1", "queued")).toThrow(
			/非法任务状态转换/
		);
	});

	it("returns the stored task for an idempotency key among 100k tasks", () => {
		const store = new MemoryTaskStore();
		const total = 100_000;
		for (let index = 0; index < total; index++) {
			store.create(run({ id: `task-${index}`, idempotencyKey: `idem-${index}` }));
		}

		const found = store.findByIdempotencyKey(`idem-${total - 1}`);

		expect(found).toBe(store.get(`task-${total - 1}`));
		expect(store.findByIdempotencyKey("idem-missing")).toBeUndefined();
	});

	it("does not scan the task map when looking up 100k tasks by key", () => {
		// 计数桩包住 tasks 的迭代：索引命中时一次 findByIdempotencyKey 的遍历次数为 0；
		// 换成 `Array.from(tasks.values()).find(...)` 这类线性扫则会是任务数量级。
		class CountingTaskMap extends Map<string, TalosTaskRun> {
			traversals = 0;

			values(): IterableIterator<TalosTaskRun> {
				const inner = super.values();
				const counting: IterableIterator<TalosTaskRun> = {
					next: (): IteratorResult<TalosTaskRun> => {
						const step = inner.next();
						if (!step.done) this.traversals++;
						return step;
					},
					[Symbol.iterator]: () => counting,
				};
				return counting;
			}
		}
		const store = new MemoryTaskStore();
		const counting = new CountingTaskMap();
		(store as unknown as { tasks: CountingTaskMap }).tasks = counting;

		store.create(run({ id: "task-single", idempotencyKey: "idem-single" }));
		counting.traversals = 0;
		store.findByIdempotencyKey("idem-single");
		const traversalsAtOneTask = counting.traversals;

		for (let index = 0; index < 100_000; index++) {
			store.create(run({ id: `bulk-${index}`, idempotencyKey: `bulk-${index}` }));
		}
		counting.traversals = 0;
		store.findByIdempotencyKey("bulk-99999");
		const traversalsAt100k = counting.traversals;

		expect(traversalsAtOneTask).toBeLessThanOrEqual(1);
		expect(traversalsAt100k).toBeLessThanOrEqual(1);
		expect(traversalsAt100k).toBe(traversalsAtOneTask);
	});

	it("keeps the idempotency index in sync when transition changes the key", () => {
		const store = new MemoryTaskStore();
		store.create(run({ id: "task-1", idempotencyKey: "idem-old" }));

		store.transition("task-1", "queued", { idempotencyKey: "idem-new" });

		expect(store.findByIdempotencyKey("idem-old")).toBeUndefined();
		expect(store.findByIdempotencyKey("idem-new")?.id).toBe("task-1");
		expect(store.get("task-1")?.idempotencyKey).toBe("idem-new");
	});

	it("still rejects a duplicate idempotency key on create", () => {
		const store = new MemoryTaskStore([run()]);

		expect(() =>
			store.create(run({ id: "task-2", idempotencyKey: "idem-1" }))
		).toThrow(/重复幂等键：idem-1/);
	});
});
