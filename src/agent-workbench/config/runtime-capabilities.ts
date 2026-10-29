import type { ProviderProfile } from "../contracts/provider-profile";
import { isDirectApiProviderProfile } from "../contracts/provider-profile";
import type { RuntimeId } from "../contracts/runtime-adapter";
import type { RuntimeCapabilities } from "../contracts/runtime-capabilities";
import { unavailableCapabilities } from "../contracts/runtime-capabilities";

/**
 * Q-ARC4：运行时能力的静态派生表。
 *
 * 背景：`contracts/runtime-capabilities.ts` 此前只写不读——`grep -rn "\.capabilities(" src/`
 * 的 3 处命中全在 `ai/provider`（另一套 `ProviderCapability`），`src/agent-workbench/` 内为 0。
 * 于是「UI 该隐藏哪些控件、执行器该拒绝哪些输入」全靠硬编码
 * （`direct-api-runtime-adapter.ts` 的 image/execute 两个拒绝分支）。
 *
 * 为什么按 (runtimeId, protocol) 派生、而不读 `AgentWorkbenchService#runtimes` 注册表：
 * 该注册表的生产装配点从未传值（`new AgentWorkbenchService({})` 等），走它只会恒回落
 * `unavailableCapabilities()`，把真实 ohmypi 误判成 image/shell 全不可用；
 * 且 `RuntimeRegistry.register` 重复注册直接 throw、lease 结束会 dispose adapter，
 * 它不该成为 UI 的能力来源。
 *
 * 放在 `config/` 而不是 `contracts/`：派生表要引用两个 adapter 的现有取值，
 * 放进 contracts 会让 contracts 反向依赖实现层（与 `provider-port.ts:1-12` 自述的
 * 「adapters → contracts ← ai/provider」方向相反）。
 */

/** Direct API 通道（anthropic-messages / openai-chat）的现有取值：Plan-only，图片不可用。 */
export function directApiCapabilities(): RuntimeCapabilities {
	return {
		session: { resume: "talos-emulated", fork: "talos-emulated", compact: "unavailable", rewind: "unavailable", steer: "unavailable" },
		input: { text: "native", image: "unavailable", vaultFile: "talos-emulated", selection: "talos-emulated" },
		tools: { shell: "unavailable", edit: "unavailable", mcp: "unavailable", skills: "unavailable", subagents: "unavailable", askUser: "unavailable" },
		control: { plan: "talos-emulated", reasoning: "native", serviceTier: "unavailable", usage: "native" },
		security: { nativeApproval: "unavailable", nativeSandbox: "unavailable", networkPolicy: "talos-emulated", externalPathGrant: "unavailable" },
	};
}

/** 本机 OhMyPi CLI 通道的现有取值：工具与图片都原生可用。 */
export function ohMyPiNativeCapabilities(): RuntimeCapabilities {
	return {
		session: { resume: "native", fork: "native", compact: "native", rewind: "unavailable", steer: "native" },
		input: { text: "native", image: "native", vaultFile: "talos-emulated", selection: "talos-emulated" },
		tools: { shell: "native", edit: "native", mcp: "native", skills: "native", subagents: "native", askUser: "native" },
		control: { plan: "native", reasoning: "native", serviceTier: "unavailable", usage: "native" },
		security: { nativeApproval: "native", nativeSandbox: "talos-emulated", networkPolicy: "talos-emulated", externalPathGrant: "talos-emulated" },
	};
}

/**
 * (runtimeId, protocol) → 能力的静态派生表。
 *
 * protocol 一维由 `isDirectApiProviderProfile()`（只检 protocol）判定，
 * 不再复制一份 protocol 清单——那种复制会变成新的漂移源。
 * 每次调用返回新对象，调用方改返回值不会污染下一个调用方。
 */
const DERIVATIONS: Partial<Record<RuntimeId, (profile: ProviderProfile | undefined) => RuntimeCapabilities>> = {
	ohmypi: (profile) => isDirectApiProviderProfile(profile) ? directApiCapabilities() : ohMyPiNativeCapabilities(),
};

export function deriveRuntimeCapabilities(input: {
	runtimeId: RuntimeId;
	providerProfile?: ProviderProfile;
}): RuntimeCapabilities {
	const derive = DERIVATIONS[input.runtimeId];
	// 未知 runtimeId（历史落盘数据里可能还有 claude / codex）：不为它猜能力，回落全不可用。
	return derive ? derive(input.providerProfile) : unavailableCapabilities();
}
