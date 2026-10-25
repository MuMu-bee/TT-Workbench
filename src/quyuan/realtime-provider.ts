/**
 * TT 1.1.0:屈原实时语音 Provider 抽象。
 * 目标:语音不再绑定阿里百炼一家——
 * - "dashscope":阿里百炼 Qwen Omni Realtime(默认,保持既有工作空间/地域/白名单语义)
 * - "openai-compatible":任何 OpenAI Realtime 兼容 WebRTC 端点
 *   (两步握手:先 POST {model, voice} 到 <endpoint>/sessions 换取临时凭据,
 *    再把 Offer SDP POST 到 <endpoint>?model=... 换 Answer SDP)
 * 安全边界不变:端点必须 HTTPS/loopback、密钥只走 SecretStorage、
 * 出库审计与会话级一次性授权全部保留。
 */

export type QuyuanRealtimeProviderKind = "dashscope" | "openai-compatible";

export interface QuyuanRealtimeProviderSettings {
	quyuanRealtimeProviderKind: string;
	quyuanRealtimeEndpoint: string;
	quyuanRealtimeSecretRef: string;
	quyuanRealtimeWorkspaceId: string;
	quyuanRealtimeRegion: string;
	quyuanRealtimeModel: string;
	quyuanRealtimeVoice: string;
}

export const DASHSCOPE_REALTIME_MODELS = [
	"qwen3.5-omni-flash-realtime",
	"qwen3.5-omni-plus-realtime",
] as const;

export const DASHSCOPE_REALTIME_VOICES = [
	"Tina",
	"Ethan",
	"Raymond",
	"Cindy",
	"Liora Mira",
	"Sunnybobi",
] as const;

export const REALTIME_PROVIDER_KINDS: ReadonlyArray<{
	id: QuyuanRealtimeProviderKind;
	label: string;
	description: string;
}> = [
	{ id: "dashscope", label: "阿里百炼 · Qwen Realtime", description: "使用百炼业务空间与地域配置,密钥存于 SecretStorage。" },
	{ id: "openai-compatible", label: "OpenAI 兼容 Realtime", description: "自定义 Realtime WebRTC 端点与模型(两步握手协议)。" },
];

export function normalizeRealtimeProviderKind(value: string): QuyuanRealtimeProviderKind {
	return value === "openai-compatible" ? "openai-compatible" : "dashscope";
}

export function quyuanRealtimeProviderId(settings: QuyuanRealtimeProviderSettings): string {
	return normalizeRealtimeProviderKind(settings.quyuanRealtimeProviderKind) === "openai-compatible"
		? "custom-openai-compatible-realtime"
		: "aliyun-qwen-realtime";
}

export function quyuanRealtimeSecretRef(settings: QuyuanRealtimeProviderSettings): string {
	if (normalizeRealtimeProviderKind(settings.quyuanRealtimeProviderKind) === "openai-compatible") {
		return settings.quyuanRealtimeSecretRef.trim() || "quyuan-realtime-key";
	}
	return "aliyunApiKey";
}

/** 面板侧会话参数解析:百炼保持白名单兜底,自定义端点按设置直通(带字符校验)。 */
export function resolveQuyuanRealtimeSessionConfig(
	settings: QuyuanRealtimeProviderSettings,
): { kind: QuyuanRealtimeProviderKind; model: string; voice: string } {
	const kind = normalizeRealtimeProviderKind(settings.quyuanRealtimeProviderKind);
	const voiceRaw = settings.quyuanRealtimeVoice.trim();
	if (kind === "dashscope") {
		const model = (DASHSCOPE_REALTIME_MODELS as readonly string[]).includes(settings.quyuanRealtimeModel)
			? settings.quyuanRealtimeModel
			: DASHSCOPE_REALTIME_MODELS[0];
		const voice = (DASHSCOPE_REALTIME_VOICES as readonly string[]).includes(voiceRaw)
			? voiceRaw
			: "Tina";
		return { kind, model, voice };
	}
	const model = settings.quyuanRealtimeModel.trim();
	if (!/^[\w.\-/]{1,128}$/.test(model)) {
		throw new Error("自定义 Realtime 模型名称无效(仅允许字母数字与 . _ - / )");
	}
	const voice = voiceRaw.replace(/[\r\n\0]/g, "").slice(0, 64) || "alloy";
	return { kind, model, voice };
}

/** 自定义 Realtime 端点校验:仅 HTTPS 或 loopback,禁止 userinfo。 */
export function validateRealtimeEndpoint(rawUrl: string): string {
	const trimmed = rawUrl.trim().replace(/\/$/, "");
	const url = new URL(trimmed);
	if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
		throw new Error("Realtime 端点必须使用 HTTPS 或 loopback");
	}
	if (url.username || url.password) {
		throw new Error("Realtime 端点不允许携带 userinfo");
	}
	return url.toString();
}
