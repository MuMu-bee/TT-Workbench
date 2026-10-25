import type { ProviderProfile } from "../contracts/provider-profile";

/**
 * TT工作台 1.1.0:原生运行时收敛为 OhMyPi 后,Provider 注册表只产出
 * 两类 Direct API profile(全部挂在 ohmypi 运行时上,由插件的 HTTP
 * 适配器直连,不启动本机 CLI):
 * - anthropic-api    → Anthropic Messages 协议
 * - openai-compatible → OpenAI Chat Completions 协议
 * OhMyPi 本机 CLI(model = provider/model 标识)不依赖本注册表注入密钥,
 * 其模型目录来自 `get_available_models`。
 * codexModel / codexBaseUrl / codexApiKey / agentWorkbenchCodexModels
 * 作为旧版数据兼容字段保留在 settings 类型中,不再参与注册表。
 */
export const TALOS_MANAGED_PROVIDER_PROFILE_IDS = [
	"anthropic-api",
	"openai-compatible",
] as const;

export interface TalosProviderProfileSettings {
	anthropicBaseUrl: string;
	openaiBaseUrl: string;
	codexBaseUrl: string;
	jarvisModel: string;
	openaiModel: string;
	codexModel: string;
	agentWorkbenchClaudeModels: string;
	agentWorkbenchCodexModels: string;
	providerSecretRefs: {
		anthropicApiKey?: string;
		openaiApiKey?: string;
		codexApiKey?: string;
	};
}

export function parseModelCatalog(value: string, legacyModel = ""): string[] {
	return Array.from(
		new Set(
			`${value}\n${legacyModel}`
				.split(/[\r\n,]+/)
				.map((model) => model.trim())
				.filter(Boolean)
		)
	);
}

export function preferredDirectApiProfile(
	profiles: ProviderProfile[],
	engineProvider: string,
): ProviderProfile | undefined {
	const preferredId = engineProvider === "claude-api"
		? "anthropic-api"
		: "openai-compatible";
	const direct = profiles.filter((profile) =>
		profile.enabled
		&& (
			profile.protocol === "openai-chat"
			|| profile.protocol === "anthropic-messages"
		)
	);
	return direct.find((profile) => profile.id === preferredId) ?? direct[0];
}

export function buildTalosProviderProfiles(
	settings: TalosProviderProfileSettings,
	hasSecret: (reference: string) => boolean
): ProviderProfile[] {
	const profiles: ProviderProfile[] = [];

	const anthropicSecretRef = settings.providerSecretRefs.anthropicApiKey;
	if (anthropicSecretRef && hasSecret(anthropicSecretRef)) {
		profiles.push({
			id: "anthropic-api",
			displayName: "Anthropic Messages · Direct API",
			runtimeId: "ohmypi",
			protocol: "anthropic-messages",
			...(settings.anthropicBaseUrl.trim()
				? { endpoint: settings.anthropicBaseUrl.trim() }
				: {}),
			models: parseModelCatalog(
				settings.agentWorkbenchClaudeModels,
				settings.jarvisModel
			).length > 0
				? parseModelCatalog(settings.agentWorkbenchClaudeModels, settings.jarvisModel)
				: ["claude-sonnet-4-6"],
			headerNames: ["x-api-key", "anthropic-version"],
			secretRef: anthropicSecretRef,
			enabled: true,
		});
	}

	const openAiSecretRef = settings.providerSecretRefs.openaiApiKey;
	if (openAiSecretRef && hasSecret(openAiSecretRef)) {
		profiles.push({
			id: "openai-compatible",
			displayName: "OpenAI-compatible · Direct API",
			runtimeId: "ohmypi",
			protocol: "openai-chat",
			...(settings.openaiBaseUrl.trim()
				? { endpoint: settings.openaiBaseUrl.trim() }
				: {}),
			models: parseModelCatalog(
				settings.agentWorkbenchCodexModels,
				settings.openaiModel
			).length > 0
				? parseModelCatalog(settings.agentWorkbenchCodexModels, settings.openaiModel)
				: ["gpt-4o"],
			headerNames: ["authorization"],
			secretRef: openAiSecretRef,
			enabled: true,
		});
	}

	return profiles;
}
