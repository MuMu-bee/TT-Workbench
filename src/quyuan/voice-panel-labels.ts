/**
 * 审查 F1:voice-panel 的纯展示逻辑抽取。
 * 这些函数不触碰 DOM 之外的状态,可从面板类中剥离并独立测试,
 * 减少 voice-panel.ts 的体量与认知负担(拆分原则:先抽纯函数,再动有状态方法)。
 */
import { resolveEffectiveRuntimePolicy } from "./runtime-policy";
import { normalizeRealtimeProviderKind, type QuyuanRealtimeProviderKind } from "./realtime-provider";

export interface VoicePanelLabelSettings {
	quyuanRealtimeModel?: string;
	quyuanRealtimeVoice?: string;
	quyuanRealtimeProviderKind?: string;
	jarvisPermissionMode?: string;
}

export const DEFAULT_REALTIME_MODEL = "qwen3.5-omni-flash-realtime";
export const DEFAULT_REALTIME_VOICE = "Tina";

/** 模型标签:设置项为空时回退默认模型。 */
export function voiceModelLabel(settings: VoicePanelLabelSettings): string {
	return settings.quyuanRealtimeModel?.trim() || DEFAULT_REALTIME_MODEL;
}

/** 音色标签:音色为空时回退默认音色。 */
export function voiceTtsLabel(settings: VoicePanelLabelSettings): string {
	return `千问 Realtime · ${settings.quyuanRealtimeVoice || DEFAULT_REALTIME_VOICE}`;
}

/** 权限标签:语音通道恒为只读策略,标签由策略层给出。 */
export function voicePermissionLabel(settings: VoicePanelLabelSettings): string {
	return resolveEffectiveRuntimePolicy({
		channel: "voice",
		permissionMode: settings.jarvisPermissionMode ?? "default",
	}).uiLabel;
}

/** 引擎按钮的可无障碍读出的描述(按 Provider 类型区分文案)。 */
export function voiceEngineAccessibleLabel(settings: VoicePanelLabelSettings): string {
	return normalizeRealtimeProviderKind(settings.quyuanRealtimeProviderKind ?? "dashscope")
		=== "openai-compatible"
		? "当前使用自定义 OpenAI 兼容 Realtime 端到端语音"
		: "当前使用百炼 Qwen Omni Realtime 端到端语音";
}

export function voiceEngineVisualLabel(): string {
	return "云端实时";
}

/** 面板"待机/监听/休眠"状态推导:未连接即 idle。 */
export function restingVoiceState(input: {
	connected: boolean;
	wakeActive: boolean;
}): "idle" | "sleep" | "listen" {
	if (!input.connected) return "idle";
	return input.wakeActive ? "listen" : "sleep";
}

export function realtimeProviderKindOf(settings: VoicePanelLabelSettings): QuyuanRealtimeProviderKind {
	return normalizeRealtimeProviderKind(settings.quyuanRealtimeProviderKind ?? "dashscope");
}
