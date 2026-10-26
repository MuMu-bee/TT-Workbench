import { createHash } from "node:crypto";
import type { ActionRequest, ApprovalDecision } from "../contracts/approval";

export interface SecurityAuditRecord {
	actionId: string;
	runtimeId: string;
	kind: string;
	canonicalToolId: string;
	risk: "A" | "B" | "C";
	targetDigests: string[];
	host?: string;
	decision: ApprovalDecision["decision"];
	reasonCode: string;
	ruleId?: string;
	timestamp: string;
	/**
	 * 无 OS 隔离后端下的明文取证字段(仅 kind === "command" 且传入 command 时写入)。
	 * 有隔离的后端不需要:隔离本身即边界,摘要足以脱敏。
	 * 无隔离时摘要不足以事后追溯,必须留下实际执行的完整命令行。
	 */
	plainCommand?: { executable: string; args: string[]; cwd: string };
}

export interface SecurityAuditSink { append(record: SecurityAuditRecord): Promise<void>; }

export interface AuditRecordOptions {
	/**
	 * 是否记录明文命令行。仅在无 OS 隔离后端(Windows 审批模式)下由调用方置为 true;
	 * 默认 false,保持既有脱敏行为完全不变。
	 */
	includePlainCommand?: boolean;
}

export function auditRecord(
	request: ActionRequest,
	decision: ApprovalDecision,
	options: AuditRecordOptions = {},
): SecurityAuditRecord {
	return {
		actionId: request.actionId,
		runtimeId: request.runtimeId,
		kind: request.kind,
		canonicalToolId: request.canonicalToolId ?? "legacy.unknown",
		risk: request.risk ?? (request.kind === "read" ? "A" : request.kind === "write" || request.kind === "unknown" ? "B" : "C"),
		targetDigests: request.targets.map((target) => createHash("sha256").update(target.canonical ?? target.raw).digest("hex")),
		host: request.network?.host,
		decision: decision.decision,
		reasonCode: decision.reasonCode ?? "legacy-decision",
		ruleId: decision.ruleId,
		timestamp: new Date().toISOString(),
		...(options.includePlainCommand && request.command
			? { plainCommand: { executable: request.command.executable, args: [...request.command.args], cwd: request.command.cwd } }
			: {}),
	};
}
