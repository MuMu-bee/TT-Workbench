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
		if (turn.workflow === "execute") {
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
		if (turn.input?.some((block) => block.type === "image")) {
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

	private mapEvent(turn: RuntimeTurn, event: ProviderAskEvent, accumulated: string) {
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
		return null;
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
		return {
			session: {
				resume: "talos-emulated",
				fork: "talos-emulated",
				compact: "unavailable",
				rewind: "unavailable",
				steer: "unavailable",
			},
			input: {
				text: "native",
				image: "unavailable",
				vaultFile: "talos-emulated",
				selection: "talos-emulated",
			},
			tools: {
				shell: "unavailable",
				edit: "unavailable",
				mcp: "unavailable",
				skills: "unavailable",
				subagents: "unavailable",
				askUser: "unavailable",
			},
			control: {
				plan: "talos-emulated",
				reasoning: "native",
				serviceTier: "unavailable",
				usage: "native",
			},
			security: {
				nativeApproval: "unavailable",
				nativeSandbox: "unavailable",
				networkPolicy: "talos-emulated",
				externalPathGrant: "unavailable",
			},
		};
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
	const provider = profile.protocol === "anthropic-messages"
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
	return provider as unknown as ProviderPort;
};

const noToolRunner = {
	async run() {
		return { content: "Direct API Plan-only 通道不执行工具", isError: true };
	},
};
