// 对话侧栏「自定义 API」：手动填写 Base URL、模型与密钥，接入已有的
// Anthropic Agent API（Claude 运行时）或 OpenAI Responses API（Codex 运行时）配置。
// 也接受 Claudian 风格的环境变量块（ANTHROPIC_BASE_URL=… 等）自动拆分。
// 本模块只做解析与校验；密钥由调用方写入 SecretStorage，不进入 data.json。
import type { RuntimeId } from "../contracts/runtime-adapter";
import { assertAllowedEndpoint } from "../contracts/provider-profile";

export type CustomApiKind = "anthropic" | "openai";

export interface CustomApiTarget {
	kind: CustomApiKind;
	label: string;
	description: string;
	runtimeId: RuntimeId;
	/** buildTalosProviderProfiles 为该类型生成的 profile id。 */
	profileId: string;
	baseUrlPlaceholder: string;
	modelPlaceholder: string;
}

export const CUSTOM_API_TARGETS: Readonly<Record<CustomApiKind, CustomApiTarget>> = {
	anthropic: {
		kind: "anthropic",
		label: "Anthropic 兼容 · Direct API",
		description: "插件直连 Anthropic Messages 协议端点（官方或兼容网关如智谱 GLM），不启动本机 CLI。",
		runtimeId: "ohmypi",
		profileId: "anthropic-api",
		baseUrlPlaceholder: "https://open.bigmodel.cn/api/anthropic",
		modelPlaceholder: "glm-5.3",
	},
	openai: {
		kind: "openai",
		label: "OpenAI 兼容 · Direct API",
		description: "插件直连 OpenAI Chat Completions 兼容端点，不启动本机 CLI。",
		runtimeId: "ohmypi",
		profileId: "openai-compatible",
		baseUrlPlaceholder: "https://api.openai.com/v1",
		modelPlaceholder: "gpt-5.5",
	},
};

export interface CustomApiDraft {
	kind: CustomApiKind;
	baseUrl: string;
	models: string[];
	/** 空字符串表示沿用已保存的密钥。 */
	apiKey: string;
}

export interface ParsedEnvBlock {
	kind?: CustomApiKind;
	baseUrl?: string;
	models?: string[];
	apiKey?: string;
}

const ENV_FIELDS: Readonly<Record<string, { kind: CustomApiKind; field: "baseUrl" | "model" | "apiKey" }>> = {
	ANTHROPIC_BASE_URL: { kind: "anthropic", field: "baseUrl" },
	ANTHROPIC_API_KEY: { kind: "anthropic", field: "apiKey" },
	ANTHROPIC_AUTH_TOKEN: { kind: "anthropic", field: "apiKey" },
	ANTHROPIC_MODEL: { kind: "anthropic", field: "model" },
	OPENAI_BASE_URL: { kind: "openai", field: "baseUrl" },
	OPENAI_API_KEY: { kind: "openai", field: "apiKey" },
	OPENAI_MODEL: { kind: "openai", field: "model" },
};

function unquote(value: string): string {
	const trimmed = value.trim();
	const quoted = /^(["'])(.*)\1$/.exec(trimmed);
	return quoted ? quoted[2].trim() : trimmed;
}

/** 解析 KEY=VALUE 环境变量块；只识别 Base URL、密钥与模型，其余行忽略。 */
export function parseEnvBlock(text: string): ParsedEnvBlock {
	const parsed: ParsedEnvBlock = {};
	const models: string[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim().replace(/^export\s+/, "");
		if (!line || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		if (separator <= 0) continue;
		const mapping = ENV_FIELDS[line.slice(0, separator).trim()];
		const value = unquote(line.slice(separator + 1));
		if (!mapping || !value) continue;
		parsed.kind ??= mapping.kind;
		if (mapping.kind !== parsed.kind) continue;
		if (mapping.field === "baseUrl") parsed.baseUrl = value;
		else if (mapping.field === "apiKey") parsed.apiKey = value;
		else models.push(value);
	}
	if (models.length) parsed.models = [...new Set(models)];
	return parsed;
}

export function parseModelList(text: string): string[] {
	return [...new Set(text.split(/[\r\n,，]+/).map((model) => model.trim()).filter(Boolean))];
}

/**
 * 返回第一条错误；全部通过时返回 null。
 *
 * Q-SEC7：判定收敛到 `contracts/provider-profile.ts` 的 `assertAllowedEndpoint`，
 * 但**保留本文件的返回值约定与字面文案**——它返回字符串而不是抛错，且
 * `tests/custom-api.test.ts:59-60` 分别断言含「HTTPS」与「账号」，
 * 所以这里把统一断言的两类错误映射回既有文案，不能直接透传
 * （透传会变成「Realtime/Provider endpoint …」并让第 60 行失败）。
 */
export function validateCustomApi(draft: CustomApiDraft, hasSavedKey: boolean): string | null {
	const baseUrl = draft.baseUrl.trim();
	if (baseUrl) {
		try {
			assertAllowedEndpoint(baseUrl, "Base URL");
		} catch (error) {
			// 解析失败（new URL 抛 TypeError）与两类策略失败必须分成三句中文字面串。
			if (!(error instanceof Error) || error.name === "TypeError") return "Base URL 不是有效地址";
			if (error.message.includes("userinfo")) return "Base URL 不能包含账号或密码";
			return "Base URL 必须是 HTTPS（本机地址可用 HTTP）";
		}
	}
	if (!draft.models.length) return "至少填写一个模型";
	if (draft.models.some((model) => /\s/.test(model))) return "模型 ID 不能包含空格";
	if (!draft.apiKey.trim() && !hasSavedKey) return "请填写 API Key";
	return null;
}

/** 保存成功后工作台要切换到的运行时、认证方式与模型。 */
export interface CustomApiResult {
	runtimeId: RuntimeId;
	profileId: string;
	model: string;
}

/** 由插件层实现：打开配置窗口，保存后返回切换目标；取消时返回 null。 */
export interface CustomApiHost {
	open(kind?: CustomApiKind): Promise<CustomApiResult | null>;
}
