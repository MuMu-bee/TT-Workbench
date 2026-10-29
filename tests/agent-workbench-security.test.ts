import { mkdtemp, mkdir, rm, symlink, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionRequest } from "../src/agent-workbench/contracts/approval";
import type { ProtocolFrame } from "../src/agent-workbench/adapters/shared/protocol-frame";
import type { RuntimeTurn } from "../src/agent-workbench/contracts/runtime-adapter";
import { OhMyPiRpcAdapter, type OhMyPiRpcPort } from "../src/agent-workbench/adapters/ohmypi/ohmypi-rpc-adapter";
import { ApprovalBroker } from "../src/agent-workbench/security/approval-broker";
import { ExternalAccessGrantStore } from "../src/agent-workbench/security/external-access-grant";
import { PermissionRuleStore, type PermissionRule } from "../src/agent-workbench/security/permission-rule-store";
import { ProcessSandbox } from "../src/agent-workbench/security/process-sandbox";
import { LoopbackEgressProxy } from "../src/agent-workbench/security/loopback-egress-proxy";
import type { SecurityAuditRecord } from "../src/agent-workbench/security/security-audit";
import { PERMANENT_SEGMENTS, VaultBoundary } from "../src/agent-workbench/security/vault-boundary";
import { codexProtectedVaultSubpaths } from "../src/agent-workbench/security/vault-protected-subpaths";
import { AgentWorkbenchService } from "../src/agent-workbench/core/agent-workbench-service";
import { normalizeToolAction } from "../src/agent-workbench/security/tool-action-normalizer";

const created: string[] = [];
afterEach(async () => {
	for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
	const vault = await mkdtemp(join(tmpdir(), "talos-vault-"));
	const outside = await mkdtemp(join(tmpdir(), "talos-outside-"));
	created.push(vault, outside);
	await mkdir(join(vault, ".vault-config"));
	await writeFile(join(vault, "note.md"), "synthetic");
	await writeFile(join(outside, "private.md"), "synthetic");
	await symlink(outside, join(vault, "escape"));
	return { vault, outside };
}

class RuleHost {
	value: PermissionRule[] = [];
	async read() { return structuredClone(this.value); }
	async write(value: PermissionRule[]) { this.value = structuredClone(value); }
}

function request(overrides: Partial<ActionRequest> = {}): ActionRequest {
	return {
		actionId: "action-1", runtimeId: "ohmypi", kind: "write",
		targets: [{ raw: "note.md", role: "destination" }], destructive: false,
		...overrides,
	};
}

function broker(vault: string, host = new RuleHost(), failAudit = false) {
	const audits: SecurityAuditRecord[] = [];
	const grants = new ExternalAccessGrantStore();
	return {
		audits, grants, host,
		value: new ApprovalBroker(
			new VaultBoundary(vault),
			new PermissionRuleStore(host),
			grants,
			{ append: async (record) => { if (failAudit) throw new Error("disk full"); audits.push(record); } },
		),
	};
}

const context = {
	workflow: "execute" as const,
	permission: "ask" as const,
	conversationId: "conversation-1",
	approvalUiAttached: true,
};

describe("VaultBoundary and ApprovalBroker", () => {
	it("blocks permanent zones and detects symlink, parent traversal and absolute escapes", async () => {
		const { vault, outside } = await fixture();
		const host = new RuleHost(); const grants = new ExternalAccessGrantStore();
		const value = new ApprovalBroker(new VaultBoundary(vault, undefined, 20, ".vault-config"), new PermissionRuleStore(host), grants, { append: async () => {} });
		expect((await value.evaluate(request({ targets: [{ raw: ".vault-config/plugins/x", role: "destination" }] }), context)).decision).toBe("deny");
		expect((await value.evaluate(request({ targets: [{ raw: "escape/private.md", role: "source" }] }), context)).decision).toBe("ask");
		expect((await value.evaluate(request({ targets: [{ raw: "../outside.md", role: "destination" }] }), context)).decision).toBe("ask");
		expect((await value.evaluate(request({ targets: [{ raw: join(outside, "private.md"), role: "source" }] }), context)).decision).toBe("ask");
	});

	// Q-SEC3：表驱动覆盖 PERMANENT_SEGMENTS 每一项 + 三个「历史行为不能丢」的点。
	it("denies every permanent segment and keeps the historical zones intact", async () => {
		const { vault } = await fixture();
		const boundary = new VaultBoundary(vault);
		const denied = async (relative: string) => {
			const assessment = await boundary.assess(request({ targets: [{ raw: relative, role: "source" }] }));
			return assessment.targets[0]?.permanentlyDenied;
		};
		for (const segment of PERMANENT_SEGMENTS) {
			expect(await denied(segment), `segment ${segment}`).toBe(true);
			expect(await denied(`${segment}/x.json`), `segment ${segment}/x.json`).toBe(true);
		}
		// 裸 `credentials` 压不住 `.talos/credentials/token.json`（前者 true、后者曾为 false）。
		expect(await denied(".talos/credentials/token.json")).toBe(true);
		expect(await denied(".git/config")).toBe(true);
		expect(await denied("credentials/x.json")).toBe(true);
		expect(await denied("secrets/y.json")).toBe(true);
	});

	// Q-SEC3 step 2：非法 configDir 不得变成启动失败——派生失败时降级为只用固定项，
	// 固定项（含 .talos/credentials）仍然生效。
	it("degrades to the fixed permanent segments when configDir is invalid", async () => {
		const { vault } = await fixture();
		const boundary = new VaultBoundary(vault, undefined, 20, "/absolute/config");
		const assessment = await boundary.assess(request({ targets: [{ raw: ".talos/credentials/token.json", role: "source" }] }));
		expect(assessment.targets[0]).toMatchObject({ permanentlyDenied: true });
	});

	// Q-SEC4：判据是 targetsTruncated，不是空数组；阈值按实测 0-3 层保留 / 4-6 层截断。
	it("flags depth-truncated targets without touching pattern-only read tools", async () => {
		const wrapped = (layers: number, payload: Record<string, unknown>) => {
			let value: Record<string, unknown> = payload;
			for (let index = 0; index < layers; index += 1) value = { nested: value };
			return value;
		};
		for (const layers of [0, 1, 2, 3]) {
			const action = normalizeToolAction({ runtimeId: "ohmypi", toolName: "read", toolInput: wrapped(layers, { file_path: "note.md" }), vaultRoot: "/synthetic/vault", actionId: `keep-${layers}` });
			expect(action.targets, `layers ${layers}`).toHaveLength(1);
			expect(action.targetsTruncated, `layers ${layers}`).toBe(false);
		}
		for (const layers of [4, 5, 6]) {
			const action = normalizeToolAction({ runtimeId: "ohmypi", toolName: "read", toolInput: wrapped(layers, { file_path: "note.md" }), vaultRoot: "/synthetic/vault", actionId: `drop-${layers}` });
			expect(action.targets, `layers ${layers}`).toHaveLength(0);
			expect(action.targetsTruncated, `layers ${layers}`).toBe(true);
		}
		for (const toolName of ["grep", "search", "glob"]) {
			const action = normalizeToolAction({ runtimeId: "ohmypi", toolName, toolInput: { pattern: "foo" }, vaultRoot: "/synthetic/vault", actionId: `pattern-${toolName}` });
			expect(action.targets, toolName).toHaveLength(0);
			expect(action.targetsTruncated, toolName).toBe(false);
		}
	});

	it("keeps Plan and Vault Full orthogonal and asks for destructive and detached actions", async () => {
		const { vault } = await fixture();
		const { value } = broker(vault);
		expect((await value.evaluate(request(), { ...context, workflow: "plan", permission: "vault-full" })).decision).toBe("deny");
		expect((await value.evaluate(request({ kind: "shell" }), { ...context, workflow: "plan" })).decision).toBe("deny");
		expect((await value.evaluate(request({ kind: "delete", destructive: true }), { ...context, workflow: "plan" })).decision).toBe("deny");
		expect((await value.evaluate(request(), { ...context, permission: "vault-full" })).decision).toBe("allow");
		expect((await value.evaluate(request({ kind: "delete", destructive: true }), { ...context, permission: "vault-full" })).decision).toBe("ask");
		expect((await value.evaluate(request(), { ...context, approvalUiAttached: false })).decision).toBe("deny");
	});

	it("persists exact scoped rules across restart and supports revocation", async () => {
		const { vault } = await fixture();
		const host = new RuleHost();
		const canonical = join(await realpath(vault), "note.md");
		const store = new PermissionRuleStore(host);
		await store.add({ id: "rule-1", runtimeId: "ohmypi", kind: "write", target: canonical, scope: "persistent", createdAt: "2026-08-26T00:00:00.000Z" });
		let current = broker(vault, host).value;
		expect((await current.evaluate(request(), { ...context, permission: "scoped" })).ruleId).toBe("rule-1");
		await new PermissionRuleStore(host).revoke("rule-1");
		current = broker(vault, host).value;
		expect((await current.evaluate(request(), { ...context, permission: "scoped" })).decision).toBe("ask");
	});

	it("requires a scoped rule for every canonical target regardless of target order", async () => {
		const { vault } = await fixture();
		await writeFile(join(vault, "other.md"), "synthetic");
		const host = new RuleHost();
		const rules = new PermissionRuleStore(host);
		const canonical = await realpath(vault);
		await rules.add({ id: "first", runtimeId: "ohmypi", kind: "write", target: join(canonical, "note.md"), scope: "persistent", createdAt: "2026-09-05T00:00:00.000Z" });
		const value = broker(vault, host).value;
		for (const paths of [["note.md", "other.md"], ["other.md", "note.md"]]) {
			expect((await value.evaluate(request({ targets: paths.map(raw => ({ raw, role: "destination" })) }), { ...context, permission: "scoped" })).decision).toBe("ask");
		}
		await rules.add({ id: "second", runtimeId: "ohmypi", kind: "write", target: join(canonical, "other.md"), scope: "persistent", createdAt: "2026-09-05T00:00:00.000Z" });
		const both = request({ targets: ["note.md", "other.md"].map(raw => ({ raw, role: "destination" })) });
		expect((await broker(vault, host).value.evaluate(both, { ...context, permission: "scoped" })).decision).toBe("allow");
		expect((await value.evaluate(request({ targets: [] }), { ...context, permission: "scoped" })).decision).toBe("ask");
	});

	it("separates fixed provider egress from generic network and consumes once grants", async () => {
		const { vault, outside } = await fixture();
		const fixtureBroker = broker(vault);
		const network = request({ kind: "network", targets: [], network: { protocol: "https", host: "api.example.test" } });
		const providerContext = { ...context, providerEgressHosts: ["api.example.test"], providerEgressRequest: true };
		expect((await fixtureBroker.value.evaluate(network, providerContext)).decision).toBe("allow");
		expect((await fixtureBroker.value.evaluate(network, { ...providerContext, workflow: "plan" })).decision).toBe("allow");
		expect((await fixtureBroker.value.evaluate(network, { ...providerContext, workflow: "plan", approvalUiAttached: false })).decision).toBe("allow");
		expect((await fixtureBroker.value.evaluate(network, { ...context, workflow: "plan", providerEgressHosts: ["api.example.test"] })).decision).toBe("deny");
		expect((await fixtureBroker.value.evaluate(network, { ...context, providerEgressHosts: ["api.example.test"] })).decision).toBe("ask");
		expect((await fixtureBroker.value.evaluate(network, context)).decision).toBe("ask");
		expect(fixtureBroker.audits).toHaveLength(6);
		const external = await realpath(join(outside, "private.md"));
		fixtureBroker.grants.add({ id: "grant-1", type: "path", value: external, direction: "read", actionId: "action-1", lifetime: "once" });
		const externalRead = request({ kind: "read", targets: [{ raw: external, role: "source" }] });
		expect((await fixtureBroker.value.evaluate(externalRead, context)).decision).toBe("allow");
		expect((await fixtureBroker.value.evaluate(externalRead, context)).decision).toBe("ask");
	});

	it("never persists risk-C network approval and requires a fresh two-phase decision", async () => {
		const { vault } = await fixture();
		const host = new RuleHost();
		const first = broker(vault, host);
		const network = request({ actionId: "network-1", kind: "network", targets: [], network: { protocol: "https", host: "example.test" } });
		const ruleId = await first.value.rememberExactRule(network, context);
		expect(ruleId).toBeNull();
		const restarted = broker(vault, host);
		const reconnect = request({ ...network, actionId: "network-2" });
		expect(await restarted.value.evaluate(reconnect, { ...context, conversationId: "conversation-2" })).toMatchObject({
			decision: "ask", reasonCode: "risk-c-two-phase",
		});
		expect(await restarted.value.evaluate(request({
			...reconnect, actionId: "network-3", network: { protocol: "https", host: "example.test", port: 8443 },
		}), context)).toMatchObject({ decision: "ask", reasonCode: "risk-c-two-phase" });
		expect(await restarted.value.evaluate(request({
			...reconnect, actionId: "network-4", runtimeId: "ohmypi",
		}), context)).toMatchObject({ decision: "ask", reasonCode: "risk-c-two-phase" });
	});

	it("fails closed when audit persistence fails and stores only target digests", async () => {
		const { vault } = await fixture();
		const failed = broker(vault, new RuleHost(), true);
		expect((await failed.value.evaluate(request({ kind: "read" }), context)).decision).toBe("deny");
		const passed = broker(vault);
		await passed.value.evaluate(request({ kind: "read" }), context);
		expect(passed.audits[0]?.targetDigests[0]).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(passed.audits)).not.toContain(vault);
	});

	// Q-SEC4：pattern-only 的只读工具不得被空数组判空误伤；
	// 被截断的那条转 ask/empty-targets，且审计里 targetsTruncated 可见。
	it("asks for truncated targets while leaving pattern-only reads allowed", async () => {
		const { vault } = await fixture();
		const fixtureBroker = broker(vault);
		const wrapped = (layers: number) => {
			let value: Record<string, unknown> = { file_path: "note.md" };
			for (let index = 0; index < layers; index += 1) value = { nested: value };
			return value;
		};
		for (const toolName of ["grep", "search", "glob"]) {
			const action = normalizeToolAction({ runtimeId: "ohmypi", toolName, toolInput: { pattern: "foo" }, vaultRoot: vault });
			const decision = await fixtureBroker.value.evaluate(action, context);
			expect(decision.decision, toolName).toBe("allow");
			expect(decision.reasonCode, toolName).toBeUndefined();
		}
		const truncated = normalizeToolAction({ runtimeId: "ohmypi", toolName: "read", toolInput: wrapped(5), vaultRoot: vault });
		const decision = await fixtureBroker.value.evaluate(truncated, context);
		expect(decision).toMatchObject({ decision: "ask", reasonCode: "empty-targets" });
		expect(fixtureBroker.audits.at(-1)).toMatchObject({ targetsTruncated: true });
	});

	// Q-SEC5：vault-full 按路径区分——普通 Vault 内写入放行并可分类，
	// 两个 talos 管理目录仍由永久禁区 deny。
	it("scopes Vault Full writes to normal in-vault paths only", async () => {
		const { vault } = await fixture();
		const { value } = broker(vault);
		const full = { ...context, permission: "vault-full" as const };
		expect(await value.evaluate(request({ targets: [{ raw: "notes/a.md", role: "destination" }] }), full))
			.toMatchObject({ decision: "allow", reasonCode: "vault-full-write" });
		for (const target of [".talos/audit/audit.jsonl", ".talos/agent-workbench/v1/permission-rules.json"]) {
			expect(await value.evaluate(request({ targets: [{ raw: target, role: "destination" }] }), full), target)
				.toMatchObject({ decision: "deny", reasonCode: "permanent-boundary" });
		}
	});

	// Q-QUA12：持久规则查询与 permission 解耦——默认 ask 模式下
	// rememberExactRule 写下的规则第一次被真正消费；未命中的请求 reasonCode 不变。
	it("consumes persisted rules under the default ask permission without changing misses", async () => {
		const { vault } = await fixture();
		const host = new RuleHost();
		const value = broker(vault, host).value;
		const remembered = await value.rememberExactRule(request(), context);
		expect(remembered).toBeTruthy();
		const decision = await value.evaluate(request({ actionId: "action-after-remember" }), context);
		expect(decision).toMatchObject({ decision: "allow", ruleId: remembered, reasonCode: "persistent-rule-match" });
		// 不命中规则的普通 read：1 个 target、无规则，reasonCode 仍为 undefined。
		await writeFile(join(vault, "unruled.md"), "synthetic");
		const miss = await value.evaluate(request({ kind: "read", targets: [{ raw: "unruled.md", role: "source" }] }), context);
		expect(miss.decision).toBe("allow");
		expect(miss.reasonCode).toBeUndefined();
	});

	// Q-ARC2：consume 语义单测。`once` 端到端不可达（tool-action-normalizer 每次
	// randomUUID 生成 actionId），因此只做这一层。
	it("consumes a once grant only for the exact actionId", async () => {
		const { vault, outside } = await fixture();
		const fixtureBroker = broker(vault);
		const external = await realpath(join(outside, "private.md"));
		fixtureBroker.grants.add({ id: "once-grant", type: "path", value: external, direction: "read", actionId: "action-once", lifetime: "once" });
		expect(fixtureBroker.grants.consume({ type: "path", value: external, direction: "read", actionId: "action-once", conversationId: "conversation-1" })?.id).toBe("once-grant");
		expect(fixtureBroker.grants.consume({ type: "path", value: external, direction: "read", actionId: "another-action", conversationId: "conversation-1" })).toBeUndefined();
	});

	// Q-ARC2 端到端：经 authorizeTool 对同一 Vault 外文件连调两次，第一次返回
	// allow-always 并写会话级授权，第二次不再弹审批（prompt 只被调用一次）。
	it("stops re-prompting for the same external path within a conversation", async () => {
		const { vault, outside } = await fixture();
		const fixtureBroker = broker(vault);
		const service = new AgentWorkbenchService({ approvalBroker: fixtureBroker.value });
		service.setWorkflowMode("execute");
		let prompts = 0;
		const decide = () => service.authorizeTool({
			runtimeId: "ohmypi", conversationId: "conversation-external", vaultRoot: vault,
			toolName: "Read", toolInput: { file_path: join(outside, "private.md") },
			approvalUiAttached: true,
			prompt: async () => { prompts += 1; return "allow-always"; },
		});
		// 第一次仍需审批（Vault 外读是 risk A，无 allow-always 语义，returns "allow"）。
		expect(await decide()).toBe("allow");
		// 第二次命中会话级授权，不再弹审批。
		expect(await decide()).toBe("allow");
		expect(prompts).toBe(1);
	});

	it("normalizes runtime tools through the service broker before showing inline approval", async () => {		const { vault } = await fixture();
		const fixtureBroker = broker(vault);
		const service = new AgentWorkbenchService({
			approvalBroker: fixtureBroker.value,
		});
		service.setWorkflowMode("execute");
		let prompts = 0;
		const approvals: Array<Record<string, unknown>> = [];
		const decide = () => service.authorizeTool({
			runtimeId: "ohmypi", conversationId: "conversation-1", vaultRoot: vault,
			toolName: "Write", toolInput: { file_path: "note.md" }, approvalUiAttached: true,
			prompt: async (approval) => {
				prompts += 1;
				approvals.push(approval);
				return "allow-always";
			},
		});
		expect(await decide()).toBe("allow-always");
		service.setPermissionMode("scoped");
		expect(await decide()).toBe("allow");
		expect(prompts).toBe(1);
		expect(approvals[0]).toMatchObject({
			phase: "execute",
			risk: "B",
			actionKind: "write",
			targets: [{ raw: "note.md", role: "destination" }],
		});
		expect(String(approvals[0]?.recovery)).toContain("恢复");
		expect(fixtureBroker.audits).toHaveLength(2);
	});

	it("extracts command path arguments and generic network hosts without persisting content", () => {
		const shell = normalizeToolAction({ runtimeId: "ohmypi", toolName: "bash", toolInput: { command: "rm ../outside.md", cwd: "." }, vaultRoot: "/synthetic/vault", actionId: "a" });
		expect(shell).toMatchObject({ kind: "shell", destructive: true, command: { executable: "rm", args: ["../outside.md"] } });
		const network = normalizeToolAction({ runtimeId: "ohmypi", toolName: "WebFetch", toolInput: { url: "https://example.test/path" }, vaultRoot: "/synthetic/vault", actionId: "b" });
		expect(network.network).toEqual({ protocol: "https", host: "example.test", port: undefined });
	});

	it("fails closed for unknown tools and classifies subagents as risk C", () => {
		const unknown = normalizeToolAction({
			runtimeId: "ohmypi", toolName: "mystery_extension", toolInput: {},
			vaultRoot: "/synthetic/vault", actionId: "unknown",
		});
		expect(unknown).toMatchObject({ kind: "unknown", risk: "B", canonicalToolId: "talos.unknown" });
		const subagent = normalizeToolAction({
			runtimeId: "ohmypi", toolName: "Task", toolInput: { description: "delegate" },
			vaultRoot: "/synthetic/vault", actionId: "subagent",
		});
		expect(subagent).toMatchObject({ kind: "subagent", risk: "C", canonicalToolId: "talos.subagent" });
		const unboundedWrite = normalizeToolAction({
			runtimeId: "ohmypi", toolName: "Write", toolInput: { content: "no target" },
			vaultRoot: "/synthetic/vault", actionId: "unbounded-write",
		});
		expect(unboundedWrite).toMatchObject({ kind: "write", risk: "C" });
	});

	it("enforces voice, governance, and two-phase risk-C gates in the shared service", async () => {
		const { vault } = await fixture();
		const prompts = vi.fn(async () => "allow" as const);
		const service = new AgentWorkbenchService({ approvalBroker: broker(vault).value });
		service.setWorkflowMode("execute");

		await expect(service.authorizeTool({
			runtimeId: "ohmypi", conversationId: "voice-1", vaultRoot: vault,
			toolName: "Write", toolInput: { file_path: "note.md" }, channel: "voice",
			approvalUiAttached: true, prompt: prompts,
		})).resolves.toBe("deny");
		expect(prompts).not.toHaveBeenCalled();

		const governed = new AgentWorkbenchService({
			approvalBroker: broker(vault).value,
			evaluateToolGovernance: () => ({ decision: "deny", reason: "policy-blocked" }),
		});
		governed.setWorkflowMode("execute");
		await expect(governed.authorizeTool({
			runtimeId: "ohmypi", conversationId: "governance-1", vaultRoot: vault,
			toolName: "Read", toolInput: { file_path: "note.md" }, channel: "text",
			approvalUiAttached: true, prompt: prompts,
		})).resolves.toBe("deny");
		expect(prompts).not.toHaveBeenCalled();

		await expect(service.authorizeTool({
			runtimeId: "ohmypi", conversationId: "voice-read-1", vaultRoot: vault,
			toolName: "Read", toolInput: { file_path: "note.md" }, channel: "voice",
			approvalUiAttached: false, prompt: prompts,
		})).resolves.toBe("allow");

		await expect(service.authorizeTool({
			runtimeId: "ohmypi", conversationId: "permanent-alias-1", vaultRoot: vault,
			toolName: "Edit", toolInput: { payload: { file_path: ".talos/private/unsafe.json" } },
			channel: "text", approvalUiAttached: true, prompt: prompts,
		})).resolves.toBe("deny");

		await expect(service.authorizeTool({
			runtimeId: "ohmypi", conversationId: "no-ui-1", vaultRoot: vault,
			toolName: "Write", toolInput: { file_path: "other.md" }, channel: "text",
			approvalUiAttached: false, prompt: prompts,
		})).resolves.toBe("deny");
		expect(prompts).not.toHaveBeenCalled();

		const unknownPrompt = vi.fn(async () => "allow-always" as const);
		const unknownInput = {
			runtimeId: "ohmypi" as const,
			conversationId: "unknown-1",
			vaultRoot: vault,
			toolName: "UnmappedProviderTool",
			toolInput: {},
			channel: "text" as const,
			approvalUiAttached: true,
			prompt: unknownPrompt,
		};
		await expect(service.authorizeTool(unknownInput)).resolves.toBe("allow");
		await expect(service.authorizeTool(unknownInput)).resolves.toBe("allow");
		expect(unknownPrompt).toHaveBeenCalledTimes(2);

		const phases: string[] = [];
		const riskCApprovals: Array<Record<string, unknown>> = [];
		const missingProposalPrompt = vi.fn(async () => "allow" as const);
		await expect(service.authorizeTool({
			runtimeId: "ohmypi", conversationId: "risk-c-no-proposal", vaultRoot: vault,
			toolName: "Task", toolInput: {}, channel: "text",
			approvalUiAttached: true, prompt: missingProposalPrompt,
		})).resolves.toBe("deny");
		expect(missingProposalPrompt).not.toHaveBeenCalled();

		await expect(service.authorizeTool({
			runtimeId: "ohmypi", conversationId: "risk-c-1", vaultRoot: vault,
			toolName: "Bash", toolInput: { command: "pwd" }, channel: "text",
			approvalUiAttached: true,
			prompt: async (approval) => {
				phases.push(approval.phase ?? "single");
				riskCApprovals.push(approval);
				return "allow";
			},
		})).resolves.toBe("allow");
		expect(phases).toEqual(["proposal", "execute"]);
		expect(riskCApprovals).toHaveLength(2);
		expect(riskCApprovals[0]).toMatchObject({
			risk: "C",
			actionKind: "shell",
			canonicalToolId: "talos.shell",
			proposalAvailable: true,
		});

		await expect(service.authorizeTool({
			runtimeId: "ohmypi", conversationId: "voice-web-denied", vaultRoot: vault,
			toolName: "web_search", toolInput: {},
			toolMetadata: {
				canonicalActionKind: "network",
				canonicalToolId: "talos.voice-web-search",
			},
			channel: "voice", approvalUiAttached: false, prompt: prompts,
		})).resolves.toBe("deny");
		await expect(service.authorizeTool({
			runtimeId: "ohmypi", conversationId: "voice-web-explicit", vaultRoot: vault,
			toolName: "web_search", toolInput: {},
			toolMetadata: {
				canonicalActionKind: "network",
				canonicalToolId: "talos.voice-web-search",
			},
			channel: "voice",
			voiceExplicitNetwork: true,
			approvalUiAttached: false,
			prompt: prompts,
		})).resolves.toBe("allow");
		await expect(governed.authorizeTool({
			runtimeId: "ohmypi", conversationId: "voice-web-governance-deny", vaultRoot: vault,
			toolName: "web_search", toolInput: {},
			toolMetadata: {
				canonicalActionKind: "network",
				canonicalToolId: "talos.voice-web-search",
			},
			channel: "voice",
			voiceExplicitNetwork: true,
			approvalUiAttached: false,
			prompt: prompts,
		})).resolves.toBe("deny");
		expect(prompts).not.toHaveBeenCalled();
	});

});

async function proxyResponse(port: number, request: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1");
		let response = "";
		socket.setEncoding("utf8");
		socket.once("error", reject);
		socket.on("data", (chunk: string) => { response += chunk; });
		socket.once("end", () => resolve(response));
		socket.once("connect", () => socket.end(request));
	});
}

describe("LoopbackEgressProxy", () => {
	it("coalesces concurrent authorization for the same CONNECT destination", async () => {
		let release!: (allowed: boolean) => void;
		let calls = 0;
		const decision = new Promise<boolean>((resolve) => { release = resolve; });
		const proxy = new LoopbackEgressProxy(async () => { calls += 1; return decision; });
		const port = await proxy.start();
		const request = "CONNECT repeated.example:443 HTTP/1.1\r\nHost: repeated.example\r\n\r\n";
		const first = proxyResponse(port, request);
		const second = proxyResponse(port, request);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(calls).toBe(1);
		release(false);
		await expect(Promise.all([first, second])).resolves.toEqual([
			expect.stringContaining("403 Forbidden"),
			expect.stringContaining("403 Forbidden"),
		]);
		await proxy.close();
	});

	it("reuses allow-always for sequential CONNECT requests to the exact destination", async () => {
		let calls = 0;
		const proxy = new LoopbackEgressProxy(async () => {
			calls += 1;
			return "allow-always";
		});
		const port = await proxy.start();
		const request = "CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
		await expect(proxyResponse(port, request)).resolves.toContain("502 Bad Gateway");
		await expect(proxyResponse(port, request)).resolves.toContain("502 Bad Gateway");
		expect(calls).toBe(1);
		await proxy.close();
	});

	it("denies CONNECT before opening an upstream socket and rejects plaintext proxying", async () => {
		const destinations: Array<{ host: string; port: number }> = [];
		const proxy = new LoopbackEgressProxy(async (destination) => {
			destinations.push(destination);
			return false;
		});
		const port = await proxy.start();
		await expect(proxyResponse(port, "CONNECT forbidden.example:443 HTTP/1.1\r\nHost: forbidden.example\r\n\r\n")).resolves.toContain("403 Forbidden");
		await expect(proxyResponse(port, "GET http://forbidden.example/ HTTP/1.1\r\nHost: forbidden.example\r\n\r\n")).resolves.toContain("405 Method Not Allowed");
		expect(destinations).toEqual([{ host: "forbidden.example", port: 443 }]);
		await proxy.close();
	});
});

describe("OhMyPi sandbox 逐回合守卫", () => {
	/** 假 port：只满足 createSession 与 prompt 的最小面。 */
	function fakePort(): OhMyPiRpcPort {
		return {
			probe: async () => ({ runtimeId: "ohmypi", status: "ready" }),
			request: async <T>(method: string): Promise<T> => {
				if (method === "new_session") return {} as T;
				if (method === "get_state") return { sessionId: "synthetic-session" } as T;
				return {} as T;
			},
			prompt: async function* (): AsyncIterable<ProtocolFrame> { /* 立即结束 */ },
			respond: async () => {},
			abort: async () => {},
			close: async () => {},
		};
	}

	function executeTurn(turnId: string): RuntimeTurn {
		return { conversationId: "conversation-sandbox", turnId, text: "hi", workflow: "execute" };
	}

	// Q-SEC8：sandboxReady 改为异步实时探针。必须先 createSession——:128 的
	// `!this.binding` 守卫在 :129 之前，不建会话到不了 sandbox 分支。
	it("re-checks sandbox availability every execute turn and fails closed", async () => {
		let ready = true;
		const adapter = new OhMyPiRpcAdapter(fakePort(), async () => ready);
		await adapter.createSession({ conversationId: "conversation-sandbox", vaultRoot: "/synthetic/vault" });
		const collect = async (turnId: string) => { for await (const event of adapter.send(executeTurn(turnId))) void event; };
		await expect(collect("turn-1")).resolves.toBeUndefined();
		ready = false;
		await expect(collect("turn-2")).rejects.toThrow("Execute 已失败关闭");
	});

	it("still requires a native session before the sandbox guard is reached", async () => {
		const adapter = new OhMyPiRpcAdapter(fakePort(), async () => false);
		const collect = async () => { for await (const event of adapter.send(executeTurn("turn-guard"))) void event; };
		await expect(collect()).rejects.toThrow("native session 尚未绑定");
	});

	it("exposes availableNow as a live probe rather than the memoized availability", async () => {
		let probes = 0;
		const sandbox = new ProcessSandbox({
			available: async () => { probes += 1; return probes === 1; },
		}, "darwin");
		// availability() 永久 memo：第二次调用不再探测。
		await expect(sandbox.availability()).resolves.toMatchObject({ available: true });
		await expect(sandbox.availability()).resolves.toMatchObject({ available: true });
		expect(probes).toBe(1);
		// availableNow() 每次实时探测，后端失效后返回 false。
		await expect(sandbox.availableNow()).resolves.toBe(false);
		expect(probes).toBe(2);
	});

	it("fails closed when the live probe itself throws", async () => {
		const sandbox = new ProcessSandbox({ available: async () => { throw new Error("probe exploded"); } }, "darwin");
		await expect(sandbox.availableNow()).resolves.toBe(false);
	});
});

describe("ProcessSandbox", () => {	it("validates the Codex permanent zones delegated to the outer sandbox", () => {
		const configDir = ".test-config";
		const subpaths = codexProtectedVaultSubpaths(configDir);
		expect(subpaths).toContain(configDir);
		// Q-SEC5：逐项覆盖，不再只断言 configDir 一项（新增禁区必须同时进 OS 沙箱清单）。
		expect(subpaths).toEqual(expect.arrayContaining([
			".talos/private",
			".talos/secrets",
			".talos/credentials",
			".talos/audit",
			".talos/agent-workbench/v1",
		]));
		expect(() => codexProtectedVaultSubpaths("/absolute/config")).toThrow("配置目录");
	});
	it("fails closed when the OS sandbox is unavailable", async () => {
		const sandbox = new ProcessSandbox({ available: async () => false }, "darwin");
		await expect(sandbox.prepare({ executable: "/usr/bin/agent", args: [], cwd: "/vault" }, "/vault")).rejects.toThrow("失败关闭");
	});

	it("allows only the exact TALOS loopback proxy and includes minimum startup reads", async () => {
		if (process.platform !== "darwin") return;
		const { vault } = await fixture();
		const sandbox = new ProcessSandbox({ available: async () => true }, "darwin");
		const protectedPaths = codexProtectedVaultSubpaths(".vault-config");
		const spec = await sandbox.prepare({
			executable: "/usr/bin/agent",
			args: ["--mode", "rpc"],
			cwd: vault,
			loopbackProxyPort: 45_678,
			deniedVaultSubpaths: protectedPaths,
			denyDotEnvFiles: true,
		}, vault);
		const profile = spec.args[1] ?? "";
		expect(spec.executable).toBe("/usr/bin/sandbox-exec");
		expect(spec.args.join(" ")).not.toMatch(/yolo|auto-approve|add-dir/);
		expect(profile).toContain('(allow network-outbound (remote tcp "localhost:45678"))');
		expect(profile.replace('(allow network-outbound (remote tcp "localhost:45678"))', "")).not.toContain("allow network-outbound");
		expect(profile).toContain("(allow sysctl-read)");
		expect(profile).toContain('(allow file-read* (literal "/"))');
		expect(profile).toContain('(global-name "com.apple.trustd.agent")');
		expect(profile).toContain('(global-name "com.apple.trustd")');
		expect(profile).toContain('(global-name "com.apple.SecurityServer")');
		expect(profile).toContain("/Library/Keychains");
		expect(profile).not.toContain("/Library/Preferences/");
		expect(profile).not.toContain("user-preference-read");
		for (const subpath of protectedPaths) {
			expect(profile).toContain(`(deny file-read* file-write* (literal "${join(await realpath(vault), subpath)}"))`);
		}
		expect(profile).toContain('(deny file-read* file-write* (regex #"');
		expect(profile).toContain("\\.env[^/]*");
		await expect(sandbox.prepare({ executable: "/usr/bin/agent", args: [], cwd: vault, loopbackProxyPort: 0 }, vault)).rejects.toThrow("端口无效");
	});

	it("enforces protected Vault paths and dot-env files in the real macOS sandbox", async () => {
		if (process.platform !== "darwin") return;
		const { vault } = await fixture();
		await writeFile(join(vault, ".vault-config", "secret.txt"), "blocked");
		await writeFile(join(vault, ".env.local"), "blocked");
		const sandbox = new ProcessSandbox({ available: async () => true }, "darwin");
		const launch = async (executable: string, args: string[]) => {
			const spec = await sandbox.prepare({
				executable,
				args,
				cwd: vault,
				deniedVaultSubpaths: codexProtectedVaultSubpaths(".vault-config"),
				denyDotEnvFiles: true,
			}, vault);
			return spawnSync(spec.executable, spec.args, {
				cwd: spec.cwd,
				encoding: "utf8",
				env: { ...process.env, ...spec.environment },
			});
		};
		expect((await launch("/bin/cat", [join(vault, "note.md")])).status).toBe(0);
		expect((await launch("/bin/cat", [join(vault, ".vault-config", "secret.txt")])).status).not.toBe(0);
		expect((await launch("/bin/cat", [join(vault, ".env.local")])).status).not.toBe(0);
		expect((await launch("/usr/bin/touch", [join(vault, "created.md")])).status).toBe(0);
		expect((await launch("/usr/bin/touch", [join(vault, ".vault-config", "blocked.md")])).status).not.toBe(0);
	});
});
