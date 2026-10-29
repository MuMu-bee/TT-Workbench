// 审批 Markdown 的共享助手：approval-actions（界面决策）与 approval-executor
// （模型执行回执）曾各带一份副本，且只有后者给正则加了 `^` 与 `m`，
// 导致标签字面量在正文任意位置出现时把该行从标签处整段替换（Q-QUA1）。
// 这里收敛成唯一实现，两条正则都带 `^` 与 `m`。

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeTitle(value: string): string {
	return value
		.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
		.replace(/\[\[([^\]]+)\]\]/g, (_match, path: string) => {
			const parts = path.split("/");
			return parts[parts.length - 1] || path;
		})
		.replace(/\*\*/g, "")
		.replace(/`/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function findCurrentSection(content: string): { start: number; end: number } | null {
	const section = /(^|\n)## 当前待审批\s*\n/.exec(content);
	if (!section || section.index === undefined) return null;
	const start = section.index + section[1].length;
	const bodyStart = start + section[0].length - section[1].length;
	const next = content.slice(bodyStart).search(/\n##\s+/);
	const end = next >= 0 ? bodyStart + next : content.length;
	return { start: bodyStart, end };
}

export function findProposalBlock(
	content: string,
	title: string
): { start: number; end: number; block: string } | null {
	const section = findCurrentSection(content);
	if (!section) return null;
	const target = normalizeTitle(title);
	const sectionText = content.slice(section.start, section.end);
	const headingRe = /^###\s+(.+?)\s*$/gm;
	let heading: RegExpExecArray | null;
	while ((heading = headingRe.exec(sectionText))) {
		if (normalizeTitle(heading[1] || "") !== target) continue;
		const start = section.start + heading.index;
		const afterHeading = sectionText.slice(heading.index + heading[0].length);
		const next = afterHeading.search(/\n###\s+/);
		const end = next >= 0 ? start + heading[0].length + next : section.end;
		return { start, end, block: content.slice(start, end) };
	}
	return null;
}

/**
 * 就地更新字段行：优先替换同名标签行，否则插到 afterLabel 行之后，再否则追加到块尾。
 * afterLabel 必填——两个调用方原先的默认值不同（"状态" / "界面操作"），
 * 合并成一份后必须由调用点显式声明插入位置。
 */
export function upsertLabeledLine(
	block: string,
	label: string,
	line: string,
	afterLabel: string
): string {
	const ownLine = new RegExp(`^\\*\\*${escapeRegExp(label)}\\*\\*[：:][^\\n]*`, "m");
	if (ownLine.test(block)) return block.replace(ownLine, line);

	const afterLine = new RegExp(`(^\\*\\*${escapeRegExp(afterLabel)}\\*\\*[：:][^\\n]*\\n)`, "m");
	if (afterLine.test(block)) return block.replace(afterLine, `$1${line}\n`);

	return `${block.trimEnd()}\n\n${line}\n`;
}
