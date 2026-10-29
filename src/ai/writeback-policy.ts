import type { TalosActionRisk } from "../action-core/types";

export type WritebackIntent = "display-only" | "knowledge" | "output";

export interface AnswerWritebackInput {
	intent: WritebackIntent;
	title: string;
	content: string;
}

export interface AnswerWritebackProposal {
	targetPath: string;
	risk: TalosActionRisk;
	approvalRequired: true;
	diffPreview: string;
	content: string;
}

function safeTitle(title: string): string {
	const sanitized = title
		.replace(/\.\.+/g, "")
		.replace(/[\\/:*?"<>|]+/g, "-")
		.replace(/\s+/g, " ")
		.replace(/^-+|-+$/g, "")
		.trim();
	return sanitized || "AI 回答";
}

/** 回写目标目录，由调用方从 TalosVaultSchema 取（不再写死旧目录名）。 */
export interface AnswerWritebackFolders {
	insights: string;
	output: string;
}

export function proposeAnswerWriteback(
	input: AnswerWritebackInput,
	folders: AnswerWritebackFolders
): AnswerWritebackProposal | null {
	if (input.intent === "display-only") return null;
	const folder = input.intent === "knowledge" ? folders.insights : folders.output;
	const title = safeTitle(input.title);
	return {
		targetPath: `${folder}/${title}.md`,
		risk: "B",
		approvalRequired: true,
		diffPreview: input.content
			.split("\n")
			.map((line) => `+${line}`)
			.join("\n"),
		content: input.content,
	};
}
