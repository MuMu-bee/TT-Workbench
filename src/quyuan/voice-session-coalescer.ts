/**
 * Q-PER10：语音会话写盘的回合级合并器。
 *
 * `VoiceSessionStore` 每个回合会产生多次 write（终稿字幕 / 助手回复 / 任务证据），
 * 原先每次 write 都穿透到全量 `saveTalosSettings`（loadData + saveData +
 * saveProviderConfigToVault + 迁移检查 + profile 同步 + 清空重建
 * askService / promptFacade）。改成「写内存即时生效 + 落盘按回合边界合并一次」。
 *
 * 抽成不依赖 DOM / Obsidian 的纯类，便于直接单测真实行为。
 */
export class VoiceSessionCoalescer {
	private dirty = false;
	private flushing = false;
	private flushedCount = 0;

	constructor(
		private readonly persist: () => Promise<void> | void,
		private readonly onError: (error: unknown) => void = (error) => {
			console.error("[TT 屈原] 语音会话落盘失败", error);
		}
	) {}

	/** 记录一次「内存已改、待落盘」。不触发 IO。 */
	markDirty(): void {
		this.dirty = true;
	}

	get pending(): boolean {
		return this.dirty;
	}

	/** 已成功落盘的次数（仅供测试与诊断观测）。 */
	get flushes(): number {
		return this.flushedCount;
	}

	/**
	 * 落盘一次（若确有待写数据）。
	 * flush 期间新到的 markDirty 不会丢：内层 while 会在同一轮里再写一次。
	 * 写失败时保留 dirty，留给下一个回合边界重试，不吞掉异常来源。
	 */
	async flush(): Promise<void> {
		if (this.flushing) {
			this.dirty = true;
			return;
		}
		if (!this.dirty) return;
		this.flushing = true;
		try {
			while (this.dirty) {
				this.dirty = false;
				await this.persist();
				this.flushedCount += 1;
			}
		} catch (error) {
			this.dirty = true;
			this.onError(error);
		} finally {
			this.flushing = false;
		}
	}
}
