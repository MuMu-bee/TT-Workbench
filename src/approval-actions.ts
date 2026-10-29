import {
	findCurrentSection,
	findProposalBlock,
	normalizeTitle,
	upsertLabeledLine,
} from "./approval-markdown.ts";

export type PendingApprovalDecision = "approve" | "reject";

export interface PendingApprovalDecisionInput {
	title: string;
	decision: PendingApprovalDecision;
	date: string;
	operator?: string;
}

export interface PendingApprovalDecisionResult {
	ok: boolean;
	content: string;
	message: string;
	removedFromPending: boolean;
}

export function isPendingApprovalStatusLine(line: string): boolean {
	return /^\*\*状态\*\*[：:]\s*待审批\s*$/.test(line.trim());
}

export function applyPendingApprovalDecision(
	content: string,
	input: PendingApprovalDecisionInput
): PendingApprovalDecisionResult {
	const title = normalizeTitle(input.title);
	if (!title) {
		return {
			ok: false,
			content,
			message: "缺少审批标题",
			removedFromPending: false,
		};
	}

	const section = findCurrentSection(content);
	if (!section) {
		return {
			ok: false,
			content,
			message: "未找到「当前待审批」段",
			removedFromPending: false,
		};
	}

	const proposal = findProposalBlock(content, title);
	if (!proposal) {
		return {
			ok: false,
			content,
			message: `未找到审批项：${title}`,
			removedFromPending: false,
		};
	}

	const statusLine = /^\*\*状态\*\*[：:][^\n]*/m;
	if (!statusLine.test(proposal.block)) {
		return {
			ok: false,
			content,
			message: `审批项缺少状态行：${title}`,
			removedFromPending: false,
		};
	}

	const actionText = input.decision === "approve" ? "批准" : "拒绝";
	const status =
		input.decision === "approve"
			? `**状态**：✅ 已批准（${input.date}，界面按钮）`
			: `**状态**：❌ 已拒绝（${input.date}，界面按钮）`;
	const execution =
		input.decision === "approve"
			? "**执行结果**：🟡 已记录审批决策，具体变更尚未执行。"
			: "**执行结果**：❌ 已拒绝，未执行提案内容。";
	const actor = input.operator ? `${input.operator} ` : "";
	const operation = `**界面操作**：${input.date} ${actor}点击「${actionText}」。`;

	let nextBlock = proposal.block.replace(statusLine, status);
	nextBlock = upsertLabeledLine(nextBlock, "执行结果", execution, "状态");
	nextBlock = upsertLabeledLine(nextBlock, "界面操作", operation, "执行结果");

	return {
		ok: true,
		content:
			content.slice(0, proposal.start) + nextBlock + content.slice(proposal.end),
		message: `已${actionText}：${title}`,
		removedFromPending: true,
	};
}
