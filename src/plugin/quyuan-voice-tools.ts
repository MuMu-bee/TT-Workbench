// TALOS 插件屈原语音工具、Realtime 会话与行内编辑；由 TalosPlugin 委托调用。
import { MODULE_KEYS } from "../data/schema";
import { QWEN_VOICE_WEB_SEARCH_MODEL, type QwenVoiceWebSearchRegion, buildQwenWebSearchRequest, parseQwenWebSearchResponse, qwenWebSearchEndpoint } from "../quyuan/qwen-web-search";
import { type QuyuanGovernanceResult, evaluateQuyuanGovernance } from "../quyuan/governance";
import { TFile, requestUrl } from "obsidian";
import { VOICE_QWEN_WEB_SEARCH_ALLOWED } from "../quyuan/runtime-policy";
import { type VoiceVaultToolName, executeVoiceVaultTool } from "../quyuan/voice-vault-tools";
import {
	DASHSCOPE_REALTIME_MODELS,
	normalizeRealtimeProviderKind,
	quyuanRealtimeProviderId,
	quyuanRealtimeSecretRef,
	validateRealtimeEndpoint,
} from "../quyuan/realtime-provider";
import type TalosPlugin from "../main";
import { auditQuyuanProviderEgress, recordQuyuanProviderUsage } from "./quyuan-egress-audit";
import { providerSecretStoreFromApp } from "../ai/provider/secret-storage-runtime";

export async function executeQuyuanVoiceVaultTool(plugin: TalosPlugin, input: {
		name: VoiceVaultToolName;
		args: Record<string, unknown>;
		sessionId?: string;
	}): Promise<string> {
	const service = plugin.getAgentWorkbenchService();
	const modulePaths = Object.fromEntries(
		MODULE_KEYS.map((key) => [key, plugin.paths.dir(key)])
	) as Record<string, string>;
	const moduleName = typeof input.args.module === "string"
		? input.args.module
		: "";
	const requestedPath = input.name === "read_vault"
		&& typeof input.args.path === "string"
		&& input.args.path.trim()
		? input.args.path
		: modulePaths[moduleName] ?? ".";
	const mapping: Record<VoiceVaultToolName, { toolName: string; canonicalToolId: string }> = {
		glob_vault: { toolName: "Glob", canonicalToolId: "talos.glob" },
		read_vault: { toolName: "Read", canonicalToolId: "talos.read" },
		grep_vault: { toolName: "Grep", canonicalToolId: "talos.grep" },
		search_vault: { toolName: "Search", canonicalToolId: "talos.search" },
	};
	const mapped = mapping[input.name];
	const approval = await service.authorizeTool({
		runtimeId: service.getSelectedRuntimeId(),
		conversationId: input.sessionId || "qwen-realtime-vault",
		vaultRoot: service.getVaultRoot(),
		toolName: mapped.toolName,
		toolInput: { ...input.args, path: requestedPath },
		toolMetadata: { canonicalActionKind: "read", canonicalToolId: mapped.canonicalToolId },
		channel: "voice",
		approvalUiAttached: false,
		prompt: async () => "deny",
	});
	if (approval === "deny") throw new Error("语音库内只读工具被统一安全策略拒绝");
	const result = await executeVoiceVaultTool({
		listPaths: async () =>
			plugin.app.vault.getMarkdownFiles().map((file) => file.path),
		read: async (path) => {
			const file = plugin.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) throw new Error("Vault 文档不存在");
			return plugin.app.vault.cachedRead(file);
		},
	}, input.name, input.args, {
		configDir: plugin.app.vault.configDir,
		modulePaths,
		maxHits: 4,
		maxExcerptChars: 900,
		maxFiles: 3000,
		maxFileChars: 400_000,
		maxConcurrency: 12,
		maxListResults: 100,
		maxReadLines: 200,
		maxGrepHits: 40,
		maxOutputChars: 6000,
		// Q-PER8：grep_vault 的逐文件全文扫描上限。与上面 maxFiles: 3000（search_vault
		// 的相关度排序候选上限）有意不同——grep 每篇都要读全文，search 只做打分。
		maxScannedFiles: 500,
	});
	const audit = await auditQuyuanProviderEgress(plugin, {
		namespace: "voice",
		kind: "vault-snippet",
		providerId: "aliyun-qwen-realtime",
		prompt: result.output,
		sourcePaths: result.sourcePaths,
		sourceKinds: ["vault-snippet"],
		sessionId: input.sessionId,
	});
	if (!audit.allowed) {
		throw new Error(audit.message || "库内片段出库审计未通过");
	}
	for (const path of result.sourcePaths) {
		plugin.recordQuyuanToolUse(result.operation, {
			...input.args,
			path,
		});
	}
	return result.output;
}

export async function executeQuyuanVoiceWebSearch(plugin: TalosPlugin, input: {
		query: string;
		callId: string;
		sessionId?: string;
	}): Promise<string> {
	if (!VOICE_QWEN_WEB_SEARCH_ALLOWED) {
		throw new Error("语音 Qwen 联网搜索未获运行策略授权");
	}
	const service = plugin.getAgentWorkbenchService();
	const approval = await service.authorizeTool({
		runtimeId: service.getSelectedRuntimeId(),
		conversationId: input.sessionId || "qwen-realtime-web-search",
		vaultRoot: service.getVaultRoot(),
		toolName: "web_search",
		toolInput: {},
		toolMetadata: {
			canonicalActionKind: "network",
			canonicalToolId: "talos.voice-web-search",
		},
		channel: "voice",
		voiceExplicitNetwork: true,
		approvalUiAttached: false,
		prompt: async () => "deny",
	});
	if (approval === "deny") throw new Error("当前语音轮的联网搜索未通过统一授权入口");
	const query = input.query.trim();
	const requestBody = buildQwenWebSearchRequest(query);
	const workspaceId = plugin.talosSettings.quyuanRealtimeWorkspaceId.trim();
	const region: QwenVoiceWebSearchRegion =
		plugin.talosSettings.quyuanRealtimeRegion === "ap-southeast-1"
			? "ap-southeast-1"
			: "cn-beijing";
	const endpoint = qwenWebSearchEndpoint(workspaceId, region);
	const aliyunKey = plugin.readProviderSecret("aliyunApiKey")?.trim();
	if (!aliyunKey) {
		throw new Error("请先在设置中安全保存百炼 API Key");
	}
	const sessionId = input.sessionId || "qwen-web-search:" + input.callId;
	const audit = await auditQuyuanProviderEgress(plugin, {
		namespace: "voice",
		kind: "web-search-query",
		providerId: "aliyun-qwen-search",
		prompt: query,
		sourceKinds: ["web-search-query"],
		sessionId,
	});
	if (!audit.allowed) {
		throw new Error(audit.message || "联网搜索问题出库审计未通过");
	}
	const response = await requestUrl({
		url: endpoint,
		method: "POST",
		headers: {
			Authorization: "Bearer " + aliyunKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(requestBody),
		throw: false,
	});
	if (response.status < 200 || response.status >= 300) {
		throw new Error("百炼联网搜索失败（HTTP " + response.status + "）");
	}
	let payload: unknown;
	try {
		payload = JSON.parse(response.text);
	} catch {
		throw new Error("百炼联网搜索返回无法解析的响应");
	}
	const result = parseQwenWebSearchResponse(payload);
	await recordQuyuanProviderUsage(plugin, {
		namespace: "voice",
		providerId: "aliyun-qwen-search",
		operation: "web-search",
		model: QWEN_VOICE_WEB_SEARCH_MODEL,
		usage: result.usage,
		sessionId,
	});
	return result.output;
}

export async function exchangeQuyuanRealtimeSdp(plugin: TalosPlugin, input: {
		model: string;
		voice?: string;
		instructions: string;
		offerSdp: string;
	}): Promise<{ answerSdp: string }> {
	const settings = plugin.talosSettings;
	const kind = normalizeRealtimeProviderKind(settings.quyuanRealtimeProviderKind);
	const providerId = quyuanRealtimeProviderId(settings);
	if (kind === "dashscope") {
		if (!(DASHSCOPE_REALTIME_MODELS as readonly string[]).includes(input.model)) {
			throw new Error("不支持的千问 Realtime 模型");
		}
	}
	if (!input.offerSdp.startsWith("v=0")) {
		throw new Error("无效的 WebRTC Offer SDP");
	}

	// 会话凭据与端点:按 Provider 类型解析(密钥一律只从 SecretStorage 读取)。
	let endpoint: URL;
	let bearer: string;
	if (kind === "dashscope") {
		const workspaceId = settings.quyuanRealtimeWorkspaceId.trim();
		if (!/^[A-Za-z0-9][A-Za-z0-9-]{2,127}$/.test(workspaceId)) {
			throw new Error("请先在设置中填写有效的百炼业务空间 ID");
		}
		const region = settings.quyuanRealtimeRegion === "ap-southeast-1"
			? "ap-southeast-1"
			: "cn-beijing";
		const aliyunKey = plugin.readProviderSecret("aliyunApiKey")?.trim();
		if (!aliyunKey) {
			throw new Error("请先在设置中安全保存百炼 API Key");
		}
		endpoint = new URL(
			`https://${workspaceId}.${region}.maas.aliyuncs.com/api/v1/webrtc/realtime`
		);
		endpoint.searchParams.set("model", input.model);
		bearer = aliyunKey;
	} else {
		const rawEndpoint = settings.quyuanRealtimeEndpoint.trim();
		if (!rawEndpoint) {
			throw new Error("请先在设置中填写自定义 Realtime 端点");
		}
		const base = validateRealtimeEndpoint(rawEndpoint);
		const secret = providerSecretStoreFromApp(plugin.app)?.get(quyuanRealtimeSecretRef(settings))?.trim() ?? null;
		if (!secret) {
			throw new Error(`请先在 SecretStorage 保存密钥并填写密钥引用(${quyuanRealtimeSecretRef(settings)})`);
		}
		// 两步握手:POST /sessions 换取临时凭据 → 以临时凭据完成 SDP 交换。
		const sessionsUrl = new URL(base.endsWith("/sessions") ? base : `${base}/sessions`);
		const sessionsResponse = await requestUrl({
			url: sessionsUrl.toString(),
			method: "POST",
			headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				model: input.model,
				...(input.voice ? { voice: input.voice } : {}),
			}),
			throw: false,
		});
		if (sessionsResponse.status < 200 || sessionsResponse.status >= 300) {
			throw new Error(
				`Realtime 会话建立失败（HTTP ${sessionsResponse.status}）：${sessionsResponse.text.slice(0, 240)}`
			);
		}
		let sessionPayload: Record<string, unknown>;
		try {
			sessionPayload = JSON.parse(sessionsResponse.text) as Record<string, unknown>;
		} catch {
			throw new Error("Realtime 会话响应无法解析");
		}
		const clientSecret = (sessionPayload.client_secret ?? null) as Record<string, unknown> | null;
		const ephemeralKey = typeof clientSecret?.value === "string" ? clientSecret.value : "";
		if (!ephemeralKey) {
			throw new Error("Realtime 会话响应缺少临时凭据(client_secret.value),已失败关闭");
		}
		endpoint = new URL(base);
		endpoint.searchParams.set("model", input.model);
		bearer = ephemeralKey;
	}

	const audit = await auditQuyuanProviderEgress(plugin, {
		namespace: "voice",
		kind: "voice-audio",
		providerId,
		prompt: input.instructions,
		sourceKinds: ["prompt", "voice-audio"],
		sessionId: `qwen-realtime-${Date.now()}`,
	});
	if (!audit.allowed) {
		throw new Error(audit.message || "实时语音出库审计未通过");
	}
	const response = await requestUrl({
		url: endpoint.toString(),
		method: "POST",
		headers: {
			Authorization: `Bearer ${bearer}`,
			"Content-Type": "application/sdp",
		},
		body: input.offerSdp,
		throw: false,
	});
	if (response.status < 200 || response.status >= 300) {
		throw new Error(
			`Realtime WebRTC SDP 交换失败（HTTP ${response.status}）：${response.text.slice(0, 240)}`
		);
	}
	if (!response.text.trim()) {
		throw new Error("Realtime WebRTC SDP 交换返回空响应");
	}
	return { answerSdp: response.text };
}

export function evaluateQuyuanToolPolicy(plugin: TalosPlugin, toolName: string, input: Record<string, unknown>): QuyuanGovernanceResult {
	return evaluateQuyuanGovernance({
		toolName,
		input,
		readPaths: plugin.quyuanReadPaths,
			configDir: plugin.app.vault.configDir,
	});
}

export async function prepareQuyuanInlineEdit(plugin: TalosPlugin, path: string): Promise<{ decision: "allow" | "deny"; reason: string }> {
	const normalized = path.replace(/\\/g, "/").replace(/^\.?\//, "");
	const slash = normalized.lastIndexOf("/");
	const readme = slash < 0
		? "_README.md"
		: `${normalized.slice(0, slash)}/_README.md`;

	try {
		if (!(await plugin.app.vault.adapter.exists(readme))) {
			return {
				decision: "deny",
				reason: `目标目录缺少 ${readme}，不能安全执行行内编辑`,
			};
		}
		await plugin.app.vault.adapter.read(readme);
		plugin.quyuanReadPaths.add(readme);
	} catch (error) {
		return {
			decision: "deny",
			reason: `无法读取 ${readme}：${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}

	const policy = evaluateQuyuanGovernance({
		toolName: "inline-edit",
		input: { file_path: normalized },
		readPaths: plugin.quyuanReadPaths,
		approvalGranted: true,
	});
	return {
		decision: policy.decision === "allow" ? "allow" : "deny",
		reason: policy.reason,
	};
}
