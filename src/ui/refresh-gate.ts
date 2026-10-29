/**
 * 刷新代际与单飞守卫（Q-QUA17 / Q-PER2）。
 *
 * `TalosView.refresh()` 是十几个采集器的串行 await，调用源彼此独立
 * （main.ts 的 1.5s debounce、侧栏按钮、决策后回刷、Lens 刷新），
 * 两次刷新交叠时旧代结果会覆盖新代（审批项「复活」）。
 *
 * 拆成不依赖 DOM / Obsidian 的纯类，便于直接单测；view.ts 只负责接线。
 *
 * 两层语义：
 * - 代际：`begin()` 每次自增，`isCurrent(gen)` 只有最新代返回 true；
 *   旧代结果既不写 this.data 也不触发重绘。
 * - 单飞 + 尾随合并：`tryBegin()` 在已有在途刷新时不再起新的一轮，
 *   只记一次 pending；在途那轮结束时 `end()` 返回 true，调用方补跑一轮。
 *   于是重叠刷新最多两轮，成本不随点击次数线性增长。
 */
export class RefreshGate {
	private generation = 0;
	private inFlight = false;
	private pending = 0;
	private discardedCount = 0;

	/** 取新代际（不改变在途状态）。 */
	begin(): number {
		this.generation += 1;
		return this.generation;
	}

	/** 该代是否仍是最新代；判否时计入丢弃计数。 */
	isCurrent(gen: number): boolean {
		if (gen === this.generation) return true;
		this.discardedCount += 1;
		return false;
	}

	/** 被丢弃的旧代结果次数。 */
	get discarded(): number {
		return this.discardedCount;
	}

	/** 在途期间收到的刷新请求数。 */
	get pendingCount(): number {
		return this.pending;
	}

	get inFlightCount(): boolean {
		return this.inFlight;
	}

	/** 是否还需补跑一轮（有在途请求被合并掉）。 */
	get needsAnotherPass(): boolean {
		return this.pending > 0;
	}

	/**
	 * 尝试开跑一轮。
	 * - 无在途：占用单飞位并取新代际，返回 `{ run: true, gen }`。
	 * - 有在途：只记一次 pending，返回 `{ run: false, gen: 0 }`。
	 */
	tryBegin(): { run: boolean; gen: number } {
		if (this.inFlight) {
			this.pending += 1;
			return { run: false, gen: 0 };
		}
		this.inFlight = true;
		return { run: true, gen: this.begin() };
	}

	/**
	 * 结束一轮。返回是否还需补跑一次：需要时把 pending 归零
	 * 并放开单飞位，让调用方新起一轮（新一轮自己再用 tryBegin 占位）。
	 */
	end(): boolean {
		this.inFlight = false;
		if (this.pending === 0) return false;
		this.pending = 0;
		return true;
	}
}
