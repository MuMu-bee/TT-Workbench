import { WEEKDAYS } from "./talos-view-model";

// Q-QUA20：时钟原先每秒 `timeEl.empty()` 后重建 5 个节点（3 段文本 + 2 个 em），
// 一天约 43 万次节点销毁创建。改为「一次性建结构 + 就地 setText」后，
// 时钟路径不再产生节点，每秒只剩 3 次文本写入。
// 格式化与绘制都抽成纯函数，便于直接单测（updateClock 是 private 方法，
// 且 TalosView 继承 Obsidian ItemView，测试里不构造它）。

export interface ClockParts {
	hh: string;
	mm: string;
	ss: string;
	dateLine: string;
	cosmosLine: string;
}

/** paintClock 只需要 setText；收窄到这条结构契约，HTMLElement 天然满足。 */
export interface TextSink {
	setText(text: string): void;
}

export interface ClockRefs {
	hh: TextSink;
	mm: TextSink;
	ss: TextSink;
	date: TextSink;
	cosmosClock: TextSink | null;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

function datePart(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function clockText(d: Date): ClockParts {
	const hh = pad(d.getHours());
	const mm = pad(d.getMinutes());
	const ss = pad(d.getSeconds());
	const date = datePart(d);
	return {
		hh,
		mm,
		ss,
		dateLine: `${date}\n周${WEEKDAYS[d.getDay()]}`,
		cosmosLine: `${date} ${hh}:${mm}:${ss}`,
	};
}

/** 只对已存在的节点调 setText，不创建、不销毁任何 DOM。 */
export function paintClock(refs: ClockRefs, parts: ClockParts): void {
	refs.hh.setText(parts.hh);
	refs.mm.setText(parts.mm);
	refs.ss.setText(parts.ss);
	refs.date.setText(parts.dateLine);
	refs.cosmosClock?.setText(parts.cosmosLine);
}
