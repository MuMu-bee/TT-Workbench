import { createHash } from "node:crypto";
import type { ActionRequest, ApprovalDecision } from "../contracts/approval";
import { sanitizeAuditValue } from "../../task-core/audit-sanitizer";

/**
 * 明文命令行落库前的脱敏：先把 `executable + args` **拼接**再匹配。
 * 必须拼接——`plainCommand` 是结构化字段，只对 `args` 跑匹配抓不到客户端名，
 * `mysql -p<口令> -u root` 的 `mysql` 在 `executable` 里。
 * `cwd` 不设例外，交给既有的 `HOME_PATH` 规则（与 Q-SEC9 同口径）。
 *
 * 结构保留：拼接串没被改动时原样返回（不重建数组，`bash -lc "rm -rf build"`
 * 这类含空格参数因此一个字节都不会变）；只有整串确实命中规则时，才逐字段
 * 带着「已处理前缀」再脱敏一次，把改动落到具体那个 arg 上——
 * 于是 `mysql -pS3cr3t` 落库为 `{ executable: "mysql", args: ["-p[REDACTED]"] }`，
 * 客户端名与参数顺序都保留。
 */
function sanitizeCommand(command: {
	executable: string;
	args: string[];
	cwd: string;
}): { executable: string; args: string[]; cwd: string } {
	const cwd = String(sanitizeAuditValue(command.cwd));
	const joined = [command.executable, ...command.args].join(" ");
	const sanitizedJoined = sanitizeAuditValue(joined);
	// 未被改动：保持原有结构与值，不引入任何新的归一化副作用。
	if (typeof sanitizedJoined !== "string" || sanitizedJoined === joined) {
		return {
			executable: command.executable,
			args: [...command.args],
			cwd,
		};
	}
	const executableValue = sanitizeAuditValue(command.executable);
	const executable =
		typeof executableValue === "string" && executableValue.trim()
			? executableValue
			: command.executable;
	const args: string[] = [];
	for (const arg of command.args) {
		const prefix = [executable, ...args].join(" ");
		const inContext = sanitizeAuditValue(`${prefix} ${arg}`);
		args.push(
			typeof inContext === "string" && inContext.startsWith(`${prefix} `)
				? inContext.slice(prefix.length + 1)
				: arg
		);
	}
	return { executable, args, cwd };
}

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
	/**
	 * 目标路径是否因深度上限被截断（`tool-action-normalizer.ts`）。历史审计文件
	 * 没有该字段属正常形状，不做回填。
	 */
	targetsTruncated?: boolean;
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
		// 只有真的被截断时才写字段，历史形状（无该键）保持不变。
		...(request.targetsTruncated === true ? { targetsTruncated: true } : {}),
		...(options.includePlainCommand && request.command
			? { plainCommand: sanitizeCommand(request.command) }
			: {}),
	};
}
