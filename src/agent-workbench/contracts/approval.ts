import type { RuntimeId } from "./runtime-adapter";

export type ActionKind = "read" | "write" | "delete" | "shell" | "network" | "export" | "mcp" | "subagent" | "unknown";
export type ActionRisk = "A" | "B" | "C";
export type WorkflowMode = "plan" | "execute";
export type PermissionMode = "ask" | "scoped" | "vault-full";

export interface ActionTarget {
	raw: string;
	canonical?: string;
	role: "source" | "destination";
}

export interface ActionRequest {
	actionId: string;
	runtimeId: RuntimeId;
	canonicalToolId?: string;
	kind: ActionKind;
	risk?: ActionRisk;
	targets: ActionTarget[];
	command?: { executable: string; args: string[]; cwd: string };
	network?: { protocol: string; host: string; port?: number };
	reason?: string;
	destructive: boolean;
	/**
	 * 目标路径因深度上限未能完整解析（`tool-action-normalizer.ts` 的
	 * `MAX_TARGET_SCAN_DEPTH`）。与「入参本来就没有路径」（grep/glob/search 的
	 * pattern-only）必须区分：后者是合法只读工具，用空数组判空会误伤。
	 */
	targetsTruncated?: boolean;
}

export interface ApprovalDecision {
	actionId: string;
	decision: "allow" | "deny" | "ask";
	reason: string;
	reasonCode?: string;
	ruleId?: string;
}
