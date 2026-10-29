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

import { assertAllowedEndpoint } from "../agent-workbench/contracts/provider-profile";

export type QuyuanRealtimeProviderKind = "dashscope" | "openai-compatible";
export interface QuyuanRealtimeProviderSettings {
	quyuanRealtimeProviderKind: string;
	quyuanRealtimeEndpoint: string;
	quyuanRealtimeSecretRef: string;
	quyuanRealtimeWorkspaceId: string;
	quyuanRealtimeRegion: string;
	quyuanRealtimeModel: string;
	quyuanRealtimeVoice: string;
	/** Q-ARC9：自定义端点的转写模型；留空则持续监听下唤醒词不可用（面板会拒绝启动）。 */
	quyuanRealtimeTranscriptionModel?: string;
}

/** 百炼固定转写模型（唤醒状态机唯一入口是转写 completed）。 */
export const DASHSCOPE_REALTIME_TRANSCRIPTION_MODEL = "qwen3-asr-flash-realtime";

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
): { kind: QuyuanRealtimeProviderKind; model: string; voice: string; transcriptionModel?: string } {
	const kind = normalizeRealtimeProviderKind(settings.quyuanRealtimeProviderKind);
	const voiceRaw = settings.quyuanRealtimeVoice.trim();
	if (kind === "dashscope") {
		const model = (DASHSCOPE_REALTIME_MODELS as readonly string[]).includes(settings.quyuanRealtimeModel)
			? settings.quyuanRealtimeModel
			: DASHSCOPE_REALTIME_MODELS[0];
		const voice = (DASHSCOPE_REALTIME_VOICES as readonly string[]).includes(voiceRaw)
			? voiceRaw
			: "Tina";
		// Q-ARC9：百炼恒有转写模型（否则 input_audio_transcription 不下发，唤醒词失效）。
		return { kind, model, voice, transcriptionModel: DASHSCOPE_REALTIME_TRANSCRIPTION_MODEL };
	}
	const model = settings.quyuanRealtimeModel.trim();
	if (!/^[\w.\-/]{1,128}$/.test(model)) {
		throw new Error("自定义 Realtime 模型名称无效(仅允许字母数字与 . _ - / )");
	}
	const voice = voiceRaw.replace(/[\r\n\0]/g, "").slice(0, 64) || "alloy";
	// Q-ARC9：自定义端点的转写模型由用户配置；允许为空（此时面板在持续监听下会拒绝启动并提示）。
	const transcriptionModel = (settings.quyuanRealtimeTranscriptionModel ?? "").trim();
	return { kind, model, voice, transcriptionModel };
}

/**
 * 自定义 Realtime 端点校验:仅 HTTPS 或 loopback,禁止 userinfo。
 *
 * Q-SEC7：判定收敛到 `contracts/provider-profile.ts` 的 `assertAllowedEndpoint`
 * （本函数只留薄封装）。收编前这里是第二套独立判定——它拒 userinfo 而 profile 侧不拒，
 * 两处已经分叉；现在任意 scheme + loopback 与 userinfo 都只有一处口径。
 *
 * 两条既有约定必须保留：
 * ① 先 `replace(/\/$/, "")` 再解析——`tests/realtime-provider.test.ts` 断言
 *    `https://api.x/v1/realtime/` → `https://api.x/v1/realtime`（去尾斜杠）；
 * ② 返回 `url.toString()`（路径为空时为裸端补 `/`）——`src/plugin/quyuan-voice-tools.ts:226`
 *    正是拿它拼 `/sessions`，所以不要去尾斜杠。
 */
export function validateRealtimeEndpoint(rawUrl: string): string {
	const url = new URL(rawUrl.trim().replace(/\/$/, ""));
	// 传 toString() 而不是 trimmed 原文：让唯一的断言函数看到规范化后的 URL，
	// 返回值仍由本函数给出，两个契约（消尾斜杠 / 补尾斜杠）都不变。
	assertAllowedEndpoint(url.toString(), "Realtime 端点");
	return url.toString();
}
