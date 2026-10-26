import type { AgentEvent } from "./agent-events";
import type { RuntimeCapabilities } from "./runtime-capabilities";

/**
 * TT工作台 1.1.0 起收敛为单一原生运行时:OhMyPi。
 * 历史值 "claude" / "codex" 的会话数据仍以字符串形式存在于持久化事件中,
 * 读取层按未知 runtime 降级处理,不再可创建新会话。
 */
export type RuntimeId = "ohmypi";
export type RuntimeHealth =
	| "unknown"
	| "probing"
	| "not-installed"
	| "incompatible"
	| "unauthenticated"
	| "ready"
	| "degraded"
	| "crashed";

export interface RuntimeProbe {
	runtimeId: RuntimeId;
	status: RuntimeHealth;
	version?: string;
	reason?: string;
	executable?: string;
	/**
	 * 隔离事实说明。当后端是"无 OS 隔离、仅审批"时为非空,
	 * UI 必须原样展示,不得省略或改写成"沙盒"措辞。
	 */
	sandboxNote?: string;
}

export interface ModelDescriptor {
	id: string;
	label: string;
	providerProfileId?: string;
	description?: string;
	isDefault?: boolean;
	reasoningOptions?: Array<{ value: string; label: string; description?: string }>;
	defaultReasoning?: string;
	serviceTiers?: Array<{ id: string; label: string; description?: string }>;
	defaultServiceTier?: string;
}

export type RuntimeInputBlock =
	| { type: "text"; text: string }
	| {
			type: "image";
			id: string;
			name: string;
			mimeType: string;
			dataUrl: string;
		};

export interface RuntimeLinkedContent {
	path: string;
	content?: string;
}

export interface RuntimeSelectionContext {
	text: string;
	source: "editor" | "browser" | "canvas";
	path?: string;
}

export interface RuntimeExecutionContext {
	linkedContent?: RuntimeLinkedContent;
	selections?: RuntimeSelectionContext[];
	externalContextPaths?: string[];
	enabledMcpServers?: string[];
}

export interface RuntimeHistoryItem {
	role: "user" | "assistant";
	text: string;
	timestamp?: string;
}

export type RuntimeToolPolicy =
	| { kind: "passive" }
	| { kind: "read-only" }
	| { kind: "provider-default" }
	| { kind: "allow-list"; names: string[] };

export interface NativeSessionBinding {
	runtimeId: RuntimeId;
	sessionId: string;
	providerProfileId?: string;
	nativeResumeToken?: string;
	protocolVersion?: string;
	lastSyncedEventId?: string;
}

export interface CreateSessionInput {
	conversationId: string;
	vaultRoot: string;
	model?: string;
	providerProfileId?: string;
	initialContext?: string;
}

export interface RuntimeTurn {
	conversationId: string;
	turnId: string;
	/** Canonical structured input. `text` remains as a compatibility projection. */
	input?: RuntimeInputBlock[];
	text: string;
	context?: RuntimeExecutionContext;
	history?: RuntimeHistoryItem[];
	model?: string;
	reasoning?: string;
	serviceTier?: string;
	workflow: "plan" | "execute";
	/**
	 * 注意:授权不由运行时执行。TT工作台 的唯一授权层是 `ApprovalBroker`
	 * (见 `contracts/approval.ts` 与 `security/approval-broker.ts`):每个工具动作
	 * 都经 broker 判定并写审计,适配器不据此字段放行工具。
	 * 该字段仅保留给"运行时自身也要知晓的粗粒度模式"(如 OhMyPi 的 `--approval-mode`
	 * 启动参数),三档语义不会逐一下发到运行时;不要用它推断实际权限。
	 * 审查 F7:原契约声明三档却与适配器实现不符,现以此注释对齐(broker 为单一授权层)。
	 */
	permissionMode?: "ask" | "scoped" | "vault-full";
	toolPolicy?: RuntimeToolPolicy;
	signal?: AbortSignal;
}

export interface RuntimeSteer {
	turnId: string;
	text: string;
}

export interface AgentRuntimeAdapter {
	readonly id: RuntimeId;
	probe(signal?: AbortSignal): Promise<RuntimeProbe>;
	listModels(signal?: AbortSignal): Promise<ModelDescriptor[]>;
	createSession(input: CreateSessionInput): Promise<NativeSessionBinding>;
	resumeSession(binding: NativeSessionBinding): Promise<void>;
	synchronizeContext?(input: { binding: NativeSessionBinding; context: string; lastEventId?: string }): Promise<void>;
	send(turn: RuntimeTurn): AsyncIterable<AgentEvent>;
	respondApproval?(input: { requestId: string | number; decision: "allow" | "allow-always" | "deny" | "cancel"; kind?: "command" | "file" | "permissions"; details?: Record<string, unknown> }): Promise<void>;
	respondUserInput?(input: { requestId: string | number; answers: Record<string, string | string[]> | null }): Promise<void>;
	steer?(input: RuntimeSteer): Promise<void>;
	cancel(reason?: string): Promise<void>;
	fork?(input: { binding: NativeSessionBinding }): Promise<NativeSessionBinding>;
	compact?(input: { binding: NativeSessionBinding }): Promise<void>;
	dispose(): Promise<void>;
	capabilities(): RuntimeCapabilities;
}
