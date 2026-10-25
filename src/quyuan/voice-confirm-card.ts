/**
 * 审查 F1:语音面板的破坏性操作二次确认卡。
 * 原为 voice-panel 内 50 行内联实现;抽出后成为自包含组件,
 * 只通过回调与宿主交互(TTS 朗读、TalosBall 状态),便于独立测试。
 */
export const CONFIRM_TIMEOUT_MS = 30_000;

export function confirmationQuestion(description: string): string {
	return `需要确认：屈原想执行「${description}」。确认吗？`;
}

export interface VoiceConfirmCardOptions {
	host: HTMLElement;
	toolName: string;
	description: string;
	/** 是否启用语音朗读问句。 */
	speak: boolean;
	feedSpeech?: (text: string) => void;
	/** 状态视觉回调:提问时 restricted,结束 done/stop。 */
	onState?: (state: "restricted" | "done" | "stop", resetAfterMs?: number) => void;
	timeoutMs?: number;
}

/** 渲染确认卡并返回用户选择;超时视为取消。 */
export function showVoiceConfirmCard(options: VoiceConfirmCardOptions): Promise<boolean> {
	const { host, toolName, description, speak } = options;
	const timeoutMs = options.timeoutMs ?? CONFIRM_TIMEOUT_MS;
	return new Promise<boolean>((resolve) => {
		const ask = confirmationQuestion(description);
		host.empty();
		const card = host.createDiv({
			cls: "tq-approval-card",
			attr: { "data-tool": toolName },
		});
		card.createDiv({ text: ask });
		const row = card.createDiv({ cls: "tq-confirm" });
		const yes = row.createEl("button", {
			cls: "tq-btn tq-btn--danger tq-btn--sm",
			attr: { type: "button" },
		});
		yes.createSpan({ text: "确认执行" });
		const no = row.createEl("button", {
			cls: "tq-btn tq-btn--secondary tq-btn--sm",
			attr: { type: "button" },
		});
		no.createSpan({ text: "取消" });
		options.onState?.("restricted");
		if (speak) options.feedSpeech?.(`${ask}请点确认或取消。`);

		let done = false;
		let timer: number | null = null;
		const finish = (value: boolean): void => {
			if (done) return;
			done = true;
			if (timer !== null) {
				window.clearTimeout(timer);
				timer = null;
			}
			yes.disabled = true;
			no.disabled = true;
			card.toggleClass("is-resolved", true);
			options.onState?.(value ? "done" : "stop", 1200);
			resolve(value);
		};
		yes.addEventListener("click", () => finish(true));
		no.addEventListener("click", () => finish(false));
		timer = window.setTimeout(() => finish(false), timeoutMs);
	});
}
