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
	/**
	 * Q-SEC7：加载时校验失败的原因。
	 *
	 * 端点判定收严后，用户存量的非法 profile（如 `ftp://127.0.0.1/x`）不能再静默丢弃——
	 * `WorkbenchSettingsStore.load()` 会保留它并把失败原因写在这里，`enabled` 同时置 false，
	 * 于是「配置还在、但不可用且说得清为什么」。非空即表示该条目未经 `validateProviderProfile`
	 * 通过，`save()` 对它不再重复校验（否则一次无关的保存会因它而整体失败）。
	 */
	invalidReason?: string;
}

export function isDirectApiProviderProfile(
	profile: ProviderProfile | undefined,
): boolean {
	return profile?.protocol === "anthropic-messages"
		|| profile?.protocol === "openai-chat";
}

/** 允许明文 http 的 loopback 主机名。 */
// WHATWG URL 的 hostname 对 IPv6 字面量带方括号（`new URL("http://[::1]:8080/x").hostname === "[::1]"`），
// 只写裸 "::1" 永远匹配不上——本会话实测两个列表原先都只有裸形式，导致合法 IPv6 loopback 被误拒。
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"] as const;

/**
 * 唯一的端点判定（Q-SEC7）：https，或 http + loopback；一律拒绝 userinfo。
 *
 * 背景：`validateProviderProfile` 原先只判 `protocol !== "https:" && !loopback`，
 * 等价于「任意 scheme + loopback 都放行」，且完全不拒 userinfo。用打包后的真实函数实测，
 * `ftp://127.0.0.1/x`、`file://127.0.0.1/etc/passwd`、`gopher://localhost:70/x`、
 * `https://user:pw@api.example.com` 全部 ACCEPTED，只有 `http://evil.example.com` 被拒；
 * 而 `quyuan/realtime-provider.ts` 自己拒 userinfo，两处已分叉。
 *
 * 关键细节：`http:` 必须显式写进条件。只判 `protocol !== "https:" && !loopback` 会让
 * ftp/file/gopher 等任意 scheme + loopback 继续穿透。
 *
 * 返回 `URL`（而不是字符串），让各调用点自行决定归一化方式——
 * profile 分支要去尾斜杠、realtime 分支要保留 `toString()` 的尾斜杠，
 * 若本函数先拆成字符串，`https://API.Example.TEST/` → `https://api.example.test`
 * 这一步的 host 大小写归一化就会丢掉。
 */
/**
 * 把 label 与后半句拼成文案，保持两处调用点原有措辞不变：
 * 英文结尾的 label（默认 `Provider endpoint`）后面加空格（原文是
 * 「Provider endpoint 必须使用 HTTPS 或 loopback」）；中文结尾的 label
 * （`Realtime 端点`）不加空格（原文是「Realtime 端点必须使用 HTTPS 或 loopback」）。
 * 写死一个空格会让 realtime 的文案多出一个空格，与收编前的字符串不再一致。
 */
function endpointMessage(label: string, detail: string): string {
	return /[\x20-\x7e]$/.test(label) ? `${label} ${detail}` : `${label}${detail}`;
}

export function assertAllowedEndpoint(rawUrl: string, label = "Provider endpoint"): URL {
	const url = new URL(rawUrl);
	if (url.username || url.password) throw new Error(endpointMessage(label, "不允许携带 userinfo"));
	const loopback = (LOOPBACK_HOSTS as readonly string[]).includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new Error(endpointMessage(label, "必须使用 HTTPS 或 loopback"));
	}
	return url;
}

export function validateProviderProfile(profile: ProviderProfile): ProviderProfile {
	if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(profile.id)) {
		throw new Error("Provider profile id 无效");
	}
	if (profile.endpoint) {
		// Q-SEC7：判定收敛到 assertAllowedEndpoint；去尾斜杠仍由 profile 分支自己做，
		// 这样 `https://API.Example.TEST/` → `https://api.example.test` 的归一化保持不变。
		const url = assertAllowedEndpoint(profile.endpoint);
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
