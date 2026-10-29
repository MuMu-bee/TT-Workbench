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

/**
 * 与 `ai/provider/types` 的 AskEvent 形状一致，由
 * `adapters/shared/provider-event-compat.ts` 的 Covers 断言守漂移。
 * 不写成 `export type ProviderAskEvent = AskEvent`：那会让 contracts 反向 import 实现层，
 * 与本文件开头自述的「adapters → contracts ← ai/provider」方向相反。
 */
export type ProviderAskEvent =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "tool-request"; toolCallId: string; name: string; input: Record<string, unknown> }
	| { type: "tool-result"; toolCallId: string; output: unknown; isError: boolean }
	| { type: "tool-skipped"; toolCallId: string; reason: "already-executed" | "review-mode" }
	| { type: "usage"; inputTokens: number; outputTokens: number }
	// retryable 必填，与 ai/provider/types.ts:45 对齐；保持可选会让 Covers 断言因可选性差异而失败
	// （本会话实测：只补 tool-skipped 仍有 TS2322，差异就是这一处可选性）。
	| { type: "error"; message: string; retryable: boolean }
	| { type: "done"; sessionId?: string };

/** 字段与 `ai/provider/types` 的 AskRequest 一致(工作台不新增字段)。 */
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
