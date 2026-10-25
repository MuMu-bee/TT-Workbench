import type { RuntimeId } from "./runtime-adapter";

export type ProviderProtocol =
	| "anthropic-agent"
	| "anthropic-messages"
	| "openai-responses"
	| "openai-chat"
	| "ohmypi-native";

export interface RuntimeProfile {
	id: string;
	runtimeId: RuntimeId;
	executablePath?: string;
	args?: string[];
}

export interface ProviderProfile {
	id: string;
	displayName: string;
	runtimeId: RuntimeId;
	protocol: ProviderProtocol;
	endpoint?: string;
	models: string[];
	headerNames?: string[];
	secretRef?: string;
	enabled: boolean;
}

export function isDirectApiProviderProfile(
	profile: ProviderProfile | undefined,
): boolean {
	return profile?.protocol === "anthropic-messages"
		|| profile?.protocol === "openai-chat";
}

export function validateProviderProfile(profile: ProviderProfile): ProviderProfile {
	if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(profile.id)) {
		throw new Error("Provider profile id 无效");
	}
	if (profile.endpoint) {
		const url = new URL(profile.endpoint);
		if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
			throw new Error("Provider endpoint 必须使用 HTTPS 或 loopback");
		}
		profile = { ...profile, endpoint: url.toString().replace(/\/$/, "") };
	}
	if (profile.runtimeId !== "ohmypi") {
		throw new Error("TT工作台 仅支持 OhMyPi 运行时的 Provider 配置");
	}
	if (!["ohmypi-native", "openai-chat", "openai-responses", "anthropic-agent", "anthropic-messages"].includes(profile.protocol)) {
		throw new Error("OhMyPi Provider 协议不兼容");
	}
	return profile;
}
