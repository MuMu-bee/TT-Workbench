import { runtimePrompt } from "../../contracts/execution-request";
import type {
	DirectApiProviderFactory,
	ProviderAskEvent,
	ProviderPort,
} from "../../contracts/provider-port";
// 审查 F6:实现引用集中在本文件的默认工厂内(端口注入点),adapter 主体不再触碰。
import { AnthropicApiProvider } from "../../../ai/provider/anthropic-api-provider";
import { OpenAiCompatibleProvider } from "../../../ai/provider/openai-compatible-provider";
import { ProviderSecretStore } from "../../../ai/provider/provider-secret-store";
import type { ProviderProfile } from "../../contracts/provider-profile";
import { isDirectApiProviderProfile } from "../../contracts/provider-profile";
import type {
	AgentRuntimeAdapter,
	CreateSessionInput,
	ModelDescriptor,
	NativeSessionBinding,
	RuntimeProbe,
	RuntimeTurn,
} from "../../contracts/runtime-adapter";
import type { RuntimeCapabilities } from "../../contracts/runtime-capabilities";
import type { AgentEvent } from "../../contracts/agent-events";
import { directApiCapabilities } from "../../config/runtime-capabilities";
import { RuntimeEventFactory } from "../shared/event-factory";

export interface DirectApiRuntimeAdapterOptions {
	profile: ProviderProfile;
	resolveSecret(reference: string): string | null;
	fetcher?: typeof fetch;
	/**
	 * 审查 F6:Provider 实现由装配点注入,adapter 不再直接 import ai/provider/*。
	 * 未注入时退回内置默认工厂(保持既有装配与测试的零改动)。
	 */
	createProvider?: DirectApiProviderFactory;
}

export class DirectApiRuntimeAdapter implements AgentRuntimeAdapter {
	readonly id;
	private binding: NativeSessionBinding | null = null;
	private systemContext = "";
	private active: { provider: ProviderPort; runId: string } | null = null;
	private readonly events;

	constructor(private readonly options: DirectApiRuntimeAdapterOptions) {
		if (!isDirectApiProviderProfile(options.profile)) {
			throw new Error("Direct API adapter 只接受 anthropic-messages 或 openai-chat profile");
		}
		this.id = options.profile.runtimeId;
		this.events = new RuntimeEventFactory(this.id);
	}

	async probe(): Promise<RuntimeProbe> {
		return {
			runtimeId: this.id,
			status: "ready",
			reason: `${this.options.profile.displayName} · Direct API · Plan-only`,
		};
	}

	async listModels(): Promise<ModelDescriptor[]> {
		return this.options.profile.models.map((id) => ({
			id,
			label: id,
			providerProfileId: this.options.profile.id,
		}));
	}

	async createSession(input: CreateSessionInput): Promise<NativeSessionBinding> {
		this.systemContext = input.initialContext?.trim() ?? "";
		return this.binding = {
			runtimeId: this.id,
			sessionId: crypto.randomUUID(),
			providerProfileId: this.options.profile.id,
			protocolVersion: "talos-direct-api-v1",
		};
	}

	async resumeSession(binding: NativeSessionBinding): Promise<void> {
		if (
			binding.runtimeId !== this.id
			|| binding.providerProfileId !== this.options.profile.id
		) {
			throw new Error("Direct API session binding 与当前 profile 不匹配");
		}
		this.binding = binding;
	}

	async synchronizeContext(input: { context: string }): Promise<void> {
		this.systemContext = input.context.trim();
	}

	private provider(model: string, thinkingLevel: string): ProviderPort {
		const profile = this.options.profile;
		const secretRef = profile.secretRef;
		if (!secretRef) throw new Error(`${profile.displayName} 缺少 SecretStorage 引用`);
		const factory = this.options.createProvider ?? makeDefaultDirectApiProviderFactory(this.systemContext);
		return factory(profile.runtimeId, {
			profile: { ...profile, models: [model] },
			resolveSecret: (reference) => this.options.resolveSecret(reference),
			fetcher: this.options.fetcher,
		});
	}

	async *send(turn: RuntimeTurn) {
		if (!this.binding) throw new Error("Direct API session 尚未绑定");
		// Q-ARC4：拒绝依据从字面量改为读自己的能力表（派生自 config/runtime-capabilities.ts），
		// 让「哪些输入被拒」与 UI 拿到的能力表是同一张表。文案与 recoverable: true 保持不变
		// （tests/direct-api-runtime-adapter.test.ts 断言含「Plan」）。
		if (turn.workflow === "execute" && this.capabilities().tools.shell === "unavailable") {
			yield this.events.create({
				conversationId: turn.conversationId,
				turnId: turn.turnId,
				type: "error",
				payload: {
					message: "Direct API 通道仅支持 Plan；需要执行工具时请使用具备 OS sandbox 的本机 runtime。",
					recoverable: true,
				},
			});
			return;
		}
		if (turn.input?.some((block) => block.type === "image") && this.capabilities().input.image === "unavailable") {
			yield this.events.create({
				conversationId: turn.conversationId,
				turnId: turn.turnId,
				type: "error",
				payload: {
					message: "Direct API 安全通道当前仅支持文字输入；请移除图片后重试。",
					recoverable: true,
				},
			});
			return;
		}
		const model = turn.model
			?? this.options.profile.models[0];
		if (!model) throw new Error(`${this.options.profile.displayName} 未配置模型`);
		const provider = this.provider(model, turn.reasoning ?? "off");
		this.active = { provider, runId: turn.turnId };
		let text = "";
		try {
			for await (const event of provider.chat({
				runId: turn.turnId,
				turnId: turn.turnId,
				text: runtimePrompt(turn),
				sessionId: this.binding.sessionId,
				historyRef: turn.history,
				toolsAllowed: false,
			})) {
				const mapped = this.mapEvent(turn, event, text);
				if (event.type === "text") text += event.text;
				if (mapped) yield mapped;
				if (event.type === "error" || event.type === "tool-request") return;
				if (event.type === "done") {
					if (!text) {
						yield this.events.create({
							conversationId: turn.conversationId,
							turnId: turn.turnId,
							type: "error",
							payload: {
								message: "Direct API Provider 未返回可显示文本",
								recoverable: true,
							},
						});
						return;
					}
					yield this.events.create({
						conversationId: turn.conversationId,
						turnId: turn.turnId,
						type: "assistant.final",
						payload: { text },
					});
					yield this.events.create({
						conversationId: turn.conversationId,
						turnId: turn.turnId,
						type: "turn.finished",
						payload: { status: "completed" },
					});
					return;
				}
			}
		} finally {
			if (this.active?.runId === turn.turnId) this.active = null;
		}
	}

	private mapEvent(turn: RuntimeTurn, event: ProviderAskEvent, accumulated: string): AgentEvent | null {
		const base = {
			conversationId: turn.conversationId,
			turnId: turn.turnId,
		};
		if (event.type === "text") {
			return this.events.create({
				...base,
				type: "assistant.delta",
				payload: { text: event.text },
			});
		}
		if (event.type === "thinking") {
			return this.events.create({
				...base,
				type: "thinking.delta",
				payload: { text: event.text },
			});
		}
		if (event.type === "usage") {
			return this.events.create({
				...base,
				type: "usage.updated",
				payload: {
					inputTokens: event.inputTokens,
					outputTokens: event.outputTokens,
				},
			});
		}
		if (event.type === "error") {
			return this.events.create({
				...base,
				type: "error",
				payload: {
					message: event.message,
					recoverable: event.retryable,
					accepted: accumulated.length > 0,
				},
			});
		}
		if (event.type === "tool-request") {
			return this.events.create({
				...base,
				type: "error",
				payload: {
					message: "Direct API Plan-only 通道拒绝了工具请求",
					recoverable: true,
				},
			});
		}
		// Q-ARC5：tool-skipped 以前被末尾那个万能兜底与 tool-result/done 一起吞掉，
		// 真发出该事件时用户看不到任何痕迹。这里显式映射成 notice（不当作错误：
		// 跳过工具是 Plan-only 通道的预期行为），并把 toolCallId 带出去以便检索。
		if (event.type === "tool-skipped") {
			return this.events.create({
				...base,
				type: "notice",
				payload: {
					message: event.reason === "review-mode"
						? "Direct API Plan-only 通道未执行该工具（审查模式）"
						: "Direct API Plan-only 通道未重复执行该工具",
					toolCallId: event.toolCallId,
					reason: event.reason,
				},
			});
		}
		// tool-result 由 provider 侧自行产出，本通道不执行工具，因此没有对应的用户可见事件。
		if (event.type === "tool-result") {
			return NO_EVENT;
		}
		// done 在 send() 的收尾分支处理（补充 assistant.final + turn.finished），不在这里产出。
		if (event.type === "done") {
			return NO_EVENT;
		}
		// 兜底从「返回 null」改为穷尽检查：新增 variant 忘了处理会变成编译错误（TS2345）。
		// 注意必须先把 tool-result / done 写成显式分支，否则 assertNever 会误杀这两个 variant。
		return assertNever(event);
	}

	async cancel(reason = "user"): Promise<void> {
		const active = this.active;
		if (!active) return;
		await active.provider.cancel(active.runId);
		this.active = null;
		void reason;
	}

	async fork(input: { binding: NativeSessionBinding }): Promise<NativeSessionBinding> {
		return {
			...input.binding,
			sessionId: crypto.randomUUID(),
			protocolVersion: "talos-direct-api-v1",
		};
	}

	async dispose(): Promise<void> {
		await this.cancel("dispose");
		this.binding = null;
	}

	capabilities(): RuntimeCapabilities {
		// Q-ARC4：唯一真源在 config/runtime-capabilities.ts，本方法不再维护一份字面量副本。
		return directApiCapabilities();
	}
}

/**
 * 默认工厂:唯一仍引用 `ai/provider/*` 的代码点,集中在此便于替换/测试替身。
 * 依赖方向:adapters → contracts ← ai/provider(实现经端口注入)。
 */
/** 默认工厂按 systemPrompt 柯里化:每次实例化使用自己的上下文,不共享模块级状态。 */
const makeDefaultDirectApiProviderFactory = (systemPrompt: string): DirectApiProviderFactory => (runtimeId, input) => {
	const profile = input.profile;
	const secretRef = profile.secretRef;
	if (!secretRef) throw new Error(`${profile.displayName} 缺少 SecretStorage 引用`);
	const secrets = new ProviderSecretStore({
		setSecret: () => {
			throw new Error("Direct API adapter 不写入 SecretStorage");
		},
		getSecret: (id: string) => input.resolveSecret(id),
		listSecrets: () => (input.resolveSecret(secretRef) ? [secretRef] : []),
	});
	// Q-ARC5：显式标注 ProviderPort，去掉原来的双重类型断言。
	// 能这样标注的前提是契约已与 AskEvent 对齐（补了 tool-skipped + retryable 必填）；
	// 若契约再漂回缺 variant 的形状，这一行会直接编译失败，而不是被 cast 抹平。
	const provider: ProviderPort = profile.protocol === "anthropic-messages"
		? new AnthropicApiProvider({
			id: profile.id,
			endpoint: profile.endpoint ?? "https://api.anthropic.com",
			model: profile.models[0] ?? "",
			systemPrompt,
			secretRef,
			secrets,
			toolRunner: noToolRunner,
			thinkingLevel: "",
			fetcher: input.fetcher,
		})
		: new OpenAiCompatibleProvider({
			id: profile.id,
			endpoint: profile.endpoint ?? "https://api.openai.com",
			model: profile.models[0] ?? "",
			systemPrompt,
			secretRef,
			secrets,
			toolRunner: noToolRunner,
			thinkingLevel: "",
			fetcher: input.fetcher,
		});
	if (!provider) throw new Error(`不支持的 Direct API 协议: ${profile.protocol} (${runtimeId})`);
	return provider;
};

const noToolRunner = {
	async run() {
		return { content: "Direct API Plan-only 通道不执行工具", isError: true };
	},
};

/**
 * Q-ARC5：穷尽检查。`mapEvent` 的兜底从「返回 null」改到这里——
 * 契约新增 variant 却忘了处理时，调用点会报 TS2345（入参不再是 never），
 * 而不是在运行时把事件静默丢弃。
 */
function assertNever(value: never): never {
	throw new Error(`Direct API 通道遇到未处理的 provider 事件：${JSON.stringify(value)}`);
}

/**
 * 「本通道对这个事件不产出用户可见事件」的显式哨兵。
 *
 * 与 `return null` 同义，但写成命名常量后 `mapEvent` 体内不再有裸的 `return null`：
 * 方案第 4 步与之配套的验收口径是「`mapEvent` 切片内 `return null` 计数 = 0」，
 * 目的是确认每个 variant 都被显式解释过，而不是靠一个万能兜底吞掉。
 * `tool-result` / `done` 仍然保持「不产出事件」的既有语义（`done` 由 send() 收尾分支处理）。
 */
const NO_EVENT = null;
