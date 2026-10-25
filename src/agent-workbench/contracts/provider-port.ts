/**
 * 审查 F6:agent-workbench 的 contracts 层端口。
 *
 * 背景:adapters/api 与 legacy 原先直接 import `src/ai/provider/*` 的实现类与类型,
 * 绕过了 contracts 边界,使工作台模块无法脱离 provider 实现独立测试/复用。
 *
 * 做法(保守,不搬动实现):在 contracts 内定义"端口"——只导出工作台需要的
 * 类型形状与工厂签名;实现仍留在 `src/ai/provider/`,由装配点
 * (`discovery/desktop-runtime-factory.ts`、`plugin/provider-runtime.ts`)注入。
 * 依赖方向因此变成 adapters → contracts ← ai/provider。
 */
import type { RuntimeId } from "./runtime-adapter";
import type { ProviderProfile } from "./provider-profile";

/** 与 `ai/provider/types` 的 AskEvent 保持结构兼容(工作台只需要这些字段)。 */
export type ProviderAskEvent =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "tool-request"; toolCallId: string; name: string; input: Record<string, unknown> }
	| { type: "tool-result"; toolCallId: string; output: unknown; isError: boolean }
	| { type: "usage"; inputTokens: number; outputTokens: number }
	| { type: "error"; message: string; retryable?: boolean }
	| { type: "done"; sessionId?: string };

/** 与 `ai/provider/types` 的 AskRequest 结构一致(工作台不新增字段)。 */
export interface ProviderAskRequest {
	runId: string;
	turnId: string;
	text: string;
	sessionId?: string;
	historyRef?: unknown;
	providerStateRef?: Record<string, unknown>;
	toolsAllowed?: boolean;
	executedToolIds?: ReadonlySet<string>;
	reviewOfTurnId?: string;
}

/** 工作台对 Provider 的最小依赖面(结构类型,实现类可隐式满足)。 */
export interface ProviderPort {
	readonly id: string;
	readonly kind: string;
	chat(request: ProviderAskRequest): AsyncIterable<ProviderAskEvent>;
	cancel(runId: string): Promise<void>;
	resume?(sessionId: string): Promise<void>;
}

export interface ProviderSecretPort {
	get(id: string): string | null;
	has(id: string): boolean;
}

export interface ProviderPortFactoryInput {
	profile: ProviderProfile;
	resolveSecret: (secretRef: string) => string | null;
	fetcher?: typeof fetch;
}

/** 由装配点提供的 Direct API Provider 构造器(工作台不感知具体实现)。 */
export type DirectApiProviderFactory = (
	runtimeId: RuntimeId,
	input: ProviderPortFactoryInput,
) => ProviderPort;
