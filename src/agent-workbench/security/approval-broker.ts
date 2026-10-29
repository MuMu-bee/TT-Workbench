import type { ActionRequest, ApprovalDecision, PermissionMode, WorkflowMode } from "../contracts/approval";
import { ExternalAccessGrantStore, grantDirection } from "./external-access-grant";
import { PermissionRuleStore } from "./permission-rule-store";
import { auditRecord, type AuditRecordOptions, type SecurityAuditSink } from "./security-audit";
import { VaultBoundary } from "./vault-boundary";

export interface ApprovalContext {
	workflow: WorkflowMode;
	permission: PermissionMode;
	conversationId: string;
	channel?: "text" | "voice";
	governance?: { decision: "allow" | "ask" | "deny"; reason: string };
	voiceExplicitNetwork?: boolean;
	providerEgressHosts?: string[];
	providerEgressRequest?: boolean;
	approvalUiAttached: boolean;
}

const MUTATING = new Set(["write", "delete", "shell", "network", "export", "mcp", "subagent", "unknown"]);
const VOICE_READ_TOOLS = new Set(["talos.read", "talos.glob", "talos.grep", "talos.search"]);

function result(request: ActionRequest, decision: ApprovalDecision["decision"], reason: string, reasonCode: string, ruleId?: string): ApprovalDecision {
	return { actionId: request.actionId, decision, reason, reasonCode, ...(ruleId ? { ruleId } : {}) };
}

function requestRisk(request: ActionRequest): "A" | "B" | "C" {
	return request.risk ?? (request.kind === "read" ? "A" : request.kind === "write" || request.kind === "unknown" ? "B" : "C");
}

function networkRuleTarget(request: ActionRequest): string | null {
	if (request.kind !== "network" || !request.network) return null;
	const rawHost = request.network.host.trim().toLowerCase().replace(/^\[|\]$/g, "");
	if (!rawHost) return null;
	const defaultPort = request.network.protocol === "https" ? 443 : request.network.protocol === "http" ? 80 : undefined;
	const port = request.network.port ?? defaultPort;
	const host = rawHost.includes(":") ? `[${rawHost}]` : rawHost;
	return port ? `${host}:${port}` : host;
}

function isProviderEgress(request: ActionRequest, context: ApprovalContext): boolean {
	return request.kind === "network"
		&& context.providerEgressRequest === true
		&& Boolean(request.network)
		&& Boolean(context.providerEgressHosts?.includes(request.network!.host));
}

function isVoiceExplicitNetwork(request: ActionRequest, context: ApprovalContext): boolean {
	return context.channel === "voice"
		&& context.voiceExplicitNetwork === true
		&& request.kind === "network"
		&& request.canonicalToolId === "talos.voice-web-search";
}

function isAllowedVoiceAction(request: ActionRequest, context: ApprovalContext): boolean {
	return (request.kind === "read" && VOICE_READ_TOOLS.has(request.canonicalToolId ?? ""))
		|| isVoiceExplicitNetwork(request, context);
}

export class ApprovalBroker {
	constructor(
		private readonly boundary: VaultBoundary,
		private readonly rules: PermissionRuleStore,
		private readonly grants: ExternalAccessGrantStore,
		private readonly audit: SecurityAuditSink,
		/**
		 * 审计记录选项。无 OS 隔离后端(Windows 审批模式)必须开启明文命令行,
		 * 以便事后追溯实际执行内容;有隔离后端保持默认脱敏。
		 */
		private readonly auditOptions: AuditRecordOptions = {},
	) {}

	async evaluate(request: ActionRequest, context: ApprovalContext): Promise<ApprovalDecision> {
		let decision: ApprovalDecision;
		try {
			if (context.channel === "voice" && !isAllowedVoiceAction(request, context)) {
				decision = result(request, "deny", "语音通道仅允许本地只读工具", "voice-hard-gate");
			} else {
				const boundary = await this.boundary.assess(request);
				if (boundary.hasPermanentDenial) {
					decision = result(request, "deny", "永久禁区不可授权", "permanent-boundary");
				} else if (context.governance?.decision === "deny") {
					decision = result(request, "deny", context.governance.reason, "governance-deny");
				} else if (context.workflow === "plan" && MUTATING.has(request.kind) && !isProviderEgress(request, context) && !isVoiceExplicitNetwork(request, context)) {
					decision = result(request, "deny", "Plan 模式禁止执行变更", "plan-mutation");
				} else if (!context.approvalUiAttached && (context.governance?.decision === "ask" || this.requiresApproval(request, boundary.hasExternalTarget, boundary.bulkDestructive)) && !isProviderEgress(request, context) && !isVoiceExplicitNetwork(request, context)) {
					decision = result(request, "deny", "审批界面不可用", "approval-ui-detached");
				} else {
					decision = await this.decide(request, context, boundary.targets, boundary.hasExternalTarget, boundary.bulkDestructive);
				}
			}
		} catch (error) {
			decision = result(request, "deny", `边界检查失败：${error instanceof Error ? error.message : "unknown"}`, "boundary-error");
		}
		try {
			await this.audit.append(auditRecord(request, decision, this.auditOptions));
			return decision;
		} catch {
			return result(request, "deny", "审计写入失败，已失败关闭", "audit-write-failed");
		}
	}

	async rememberExactRule(request: ActionRequest, _context: ApprovalContext): Promise<string | null> {
		if (requestRisk(request) === "C" || request.kind === "unknown") return null;
		if (request.kind === "network" && request.network) {
			const target = networkRuleTarget(request);
			if (!target) return null;
			const id = crypto.randomUUID();
			await this.rules.add({
				id,
				runtimeId: request.runtimeId,
				kind: "network",
				target,
				scope: "persistent",
				createdAt: new Date().toISOString(),
			});
			return id;
		}
		if (request.kind !== "read" && request.kind !== "write") return null;
		const assessment = await this.boundary.assess(request);
		if (assessment.hasExternalTarget || assessment.hasPermanentDenial || assessment.targets.length !== 1) return null;
		const id = crypto.randomUUID();
		await this.rules.add({ id, runtimeId: request.runtimeId, kind: request.kind, target: assessment.targets[0].canonical, scope: "persistent", createdAt: new Date().toISOString() });
		return id;
	}

	private requiresApproval(request: ActionRequest, external: boolean, bulk: boolean): boolean {
		return request.destructive || external || bulk || MUTATING.has(request.kind);
	}

	/**
	 * 回收某会话的会话级外部授权。`rememberExternalGrant` 是唯一的生产者
	 * （在此之前 `ExternalAccessGrantStore.clearConversation` 全仓零调用），
	 * 会话 `deleted` 时必须把对应授权一起清掉。
	 */
	clearConversation(conversationId: string): void {
		this.grants.clearConversation(conversationId);
	}

	/**
	 * 为 Vault 外目标 / 网络主机写会话级（或一次性）精确授权。
	 *
	 * 这是 `grants.add` 的生产者——在此之前 `ExternalAccessGrantStore` 只有
	 * `consume` 的读者、没有写入方，`decide()` 的 Vault 外分支永远 miss，
	 * 只能回落到 ask。存储是内存 Map，收益只到「本次会话内」，重启后需重新授权。
	 *
	 * 调用约束（由 `AgentWorkbenchService.authorizeTool` 保证）：
	 * 必须在 `evaluate` 之后、且不得在 `governance.decision === 'deny'` 或
	 * 「审批界面不可用」路径里写，否则等于绕过审批。
	 */
	async rememberExternalGrant(
		request: ActionRequest,
		context: ApprovalContext,
		lifetime: "once" | "conversation",
	): Promise<string | null> {
		const assessment = await this.boundary.assess(request);
		const externalTargets = assessment.targets.filter((target) => !target.insideVault);
		const host = request.kind === "network" && request.network ? request.network.host : undefined;
		// 无外部目标也无网络时不写空授权。
		if (externalTargets.length === 0 && !host) return null;
		const ids: string[] = [];
		for (const target of externalTargets) {
			const id = crypto.randomUUID();
			this.grants.add({
				id,
				type: "path",
				value: target.canonical,
				direction: grantDirection(request.kind),
				actionId: request.actionId,
				lifetime,
				conversationId: context.conversationId,
			});
			ids.push(id);
		}
		if (host) {
			const id = crypto.randomUUID();
			this.grants.add({
				id,
				type: "host",
				value: host,
				direction: "network",
				actionId: request.actionId,
				lifetime,
				conversationId: context.conversationId,
			});
			ids.push(id);
		}
		return ids[0] ?? null;
	}

	private async decide(
		request: ActionRequest,
		context: ApprovalContext,
		targets: Array<{ canonical: string; insideVault: boolean }>,
		external: boolean,
		bulk: boolean,
	): Promise<ApprovalDecision> {
		if (isProviderEgress(request, context)) return result(request, "allow", "已确认 Provider endpoint", "provider-egress");
		if (isVoiceExplicitNetwork(request, context)) return result(request, "allow", "当前语音轮已明确授权固定联网搜索", "voice-explicit-web-search");
		if (context.governance?.decision === "ask") return result(request, "ask", context.governance.reason, "governance-approval-required");
		if (requestRisk(request) === "C") return result(request, "ask", "C 类动作必须先展示提案并再次确认执行", "risk-c-two-phase");
		if (request.kind === "unknown") return result(request, "ask", "未知工具只允许本次显式审批", "unknown-tool-ask-once");
		if (request.kind === "network" && request.network) {
			if (isProviderEgress(request, context)) {
				return { actionId: request.actionId, decision: "allow", reason: "已确认 Provider endpoint" };
			}
			const target = networkRuleTarget(request);
			if (target) {
				const rule = await this.rules.match({ runtimeId: request.runtimeId, kind: "network", target, conversationId: context.conversationId });
				if (rule) return { actionId: request.actionId, decision: "allow", reason: "命中精确持久网络授权", ruleId: rule.id };
			}
			const grant = this.grants.consume({ type: "host", value: request.network.host, direction: "network", actionId: request.actionId, conversationId: context.conversationId });
			if (grant) return { actionId: request.actionId, decision: "allow", reason: "命中精确网络授权", ruleId: grant.id };
			return { actionId: request.actionId, decision: "ask", reason: "通用网络请求需要审批" };
		}
		if (external) {
			for (const target of targets.filter((item) => !item.insideVault)) {
				const grant = this.grants.consume({ type: "path", value: target.canonical, direction: grantDirection(request.kind), actionId: request.actionId, conversationId: context.conversationId });
				if (!grant) return { actionId: request.actionId, decision: "ask", reason: "Vault 外目标需要精确授权" };
			}
			return { actionId: request.actionId, decision: "allow", reason: "命中 Vault 外精确授权" };
		}
		if (request.destructive || bulk || request.kind === "delete" || request.kind === "export" || request.kind === "mcp" || request.kind === "shell") {
			return { actionId: request.actionId, decision: "ask", reason: "敏感动作需要审批" };
		}
		// Q-SEC4：判据必须是 targetsTruncated，不是 targets.length === 0。
		// grep/search/glob 的 pattern-only 入参本来就是 0 targets 且当前 allow，
		// 用裸长度判空会让每次 glob/search 都弹审批。决策钉死为 ask（不是 deny）。
		if (request.kind !== "network" && request.targetsTruncated === true && targets.length === 0) {
			return result(request, "ask", "目标路径未能完整解析，已按待审批处理", "empty-targets");
		}
		// Q-QUA12：规则查询与 permission 解耦（默认 ask 下「允许并记住」才真正生效），
		// 但必须排在空目标守卫与 destructive/bulk/shell 拦截之后。
		if ((request.kind === "read" || request.kind === "write") && targets.length > 0) {
			const ruleId = await this.matchingRuleId(request, targets, context.conversationId);
			if (ruleId) return result(request, "allow", "全部目标命中精确权限规则", "persistent-rule-match", ruleId);
		}
		if (request.kind === "read") return { actionId: request.actionId, decision: "allow", reason: "Vault 内安全读取" };
		// Q-SEC5：vault-full 不再无条件放行写入——路径必须全部在 Vault 内且非空。
		// 永久禁区（含 .talos/audit 与 .talos/agent-workbench/v1）在 evaluate() 早已 deny。
		if (context.permission === "vault-full" && request.kind === "write" && targets.length > 0 && targets.every((target) => target.insideVault)) {
			return result(request, "allow", "Vault Full 允许普通 Vault 内写入", "vault-full-write");
		}
		if (context.permission === "scoped" && targets.length > 0) {
			const ruleId = await this.matchingRuleId(request, targets, context.conversationId);
			// 未命中不改措辞也不改 reasonCode：本改动只影响命中规则的请求。
			if (!ruleId) return { actionId: request.actionId, decision: "ask", reason: "部分目标缺少精确权限规则" };
			return result(request, "allow", "全部目标命中精确权限规则", "persistent-rule-match", ruleId);
		}
		return { actionId: request.actionId, decision: "ask", reason: "动作需要审批" };
	}

	/**
	 * 「全部目标命中精确权限规则」的唯一实现：任一 target 未命中即返回 undefined，
	 * 全命中返回首个 rule.id。scoped 分支与 permission 无关的规则分支共用它，
	 * 避免同一状态机两套措辞。
	 */
	private async matchingRuleId(
		request: ActionRequest,
		targets: Array<{ canonical: string }>,
		conversationId: string,
	): Promise<string | undefined> {
		let matchedRuleId: string | undefined;
		for (const target of targets) {
			const rule = await this.rules.match({ runtimeId: request.runtimeId, kind: request.kind, target: target.canonical, conversationId });
			if (!rule) return undefined;
			matchedRuleId ??= rule.id;
		}
		return matchedRuleId;
	}
}
