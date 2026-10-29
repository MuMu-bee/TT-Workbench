import {
	escapeRegExp,
	findProposalBlock,
	upsertLabeledLine,
} from "./approval-markdown.ts";

export interface ApprovalExecutableSpec {
	title: string;
	executor: string;
	targetPath: string;
	instruction: string;
}

export interface MockModelAppendInput {
	title: string;
	targetPath: string;
	instruction: string;
	date: string;
	time: string;
	originalContent: string;
}

export interface ApprovalExecutionRecordInput {
	title: string;
	targetPath: string;
	date: string;
	time: string;
	executor: string;
}

export interface ApprovalExecutionResult {
	ok: boolean;
	content: string;
	message: string;
}

function readField(block: string, label: string): string {
	const field = new RegExp(
		`^\\*\\*${escapeRegExp(label)}\\*\\*[：:]\\s*(.+?)\\s*$`,
		"m"
	).exec(block);
	return (field?.[1] || "").trim();
}

export function parseApprovalExecutableSpec(
	content: string,
	title: string
): ApprovalExecutableSpec | null {
	const proposal = findProposalBlock(content, title);
	if (!proposal) return null;
	const executor = readField(proposal.block, "执行器");
	const targetPath = readField(proposal.block, "目标文件");
	const instruction = readField(proposal.block, "执行指令");
	if (!executor || !targetPath || !instruction) return null;
	return { title, executor, targetPath, instruction };
}

export function buildMockModelAppend(input: MockModelAppendInput): string {
	const existingWords = input.originalContent
		.replace(/---[\s\S]*?---/, "")
		.replace(/\s+/g, "")
		.length;
	return [
		"",
		`## TALOS 模型执行测试 ${input.date} ${input.time}`,
		"",
		`- 审批项：${input.title}`,
		`- 目标文件：${input.targetPath}`,
		`- 执行器：mock-model-file-append`,
		`- 执行指令：${input.instruction}`,
		`- 模型处理摘要：本地模拟模型已读取目标文件（正文约 ${existingWords} 字符），并按审批指令追加本回执。`,
		"- 安全边界：本次只写入此目标文件，不执行 shell，不访问网络，不修改其它库内文件。",
		"",
	].join("\n");
}

export function applyApprovalExecutionRecord(
	content: string,
	input: ApprovalExecutionRecordInput
): ApprovalExecutionResult {
	const proposal = findProposalBlock(content, input.title);
	if (!proposal) {
		return { ok: false, content, message: `未找到审批项：${input.title}` };
	}
	let nextBlock = proposal.block;
	nextBlock = upsertLabeledLine(
		nextBlock,
		"模型执行结果",
		`**模型执行结果**：✅ 已执行（${input.date} ${input.time}，${input.executor}）`,
		"界面操作"
	);
	nextBlock = upsertLabeledLine(
		nextBlock,
		"模型执行目标",
		`**模型执行目标**：${input.targetPath}`,
		"模型执行结果"
	);
	nextBlock = upsertLabeledLine(
		nextBlock,
		"执行结果",
		"**执行结果**：✅ 已批准并完成模型执行测试。",
		"模型执行目标"
	);

	return {
		ok: true,
		content:
			content.slice(0, proposal.start) + nextBlock + content.slice(proposal.end),
		message: `模型执行测试已写回：${input.targetPath}`,
	};
}
