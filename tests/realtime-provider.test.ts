import { describe, expect, it } from "vitest";
import {
	DASHSCOPE_REALTIME_MODELS,
	REALTIME_PROVIDER_KINDS,
	normalizeRealtimeProviderKind,
	quyuanRealtimeProviderId,
	quyuanRealtimeSecretRef,
	resolveQuyuanRealtimeSessionConfig,
	validateRealtimeEndpoint,
	type QuyuanRealtimeProviderSettings,
} from "../src/quyuan/realtime-provider";

/**
 * Q-TES8：`realtime-provider.ts` 此前零测试覆盖（`grep -rn 'realtime-provider' tests/` = 0），
 * 而 `ACCEPTANCE.md:103` 却把 B3 端点校验标为「单元测试 + 类型验证」。
 *
 * 本文件的第一组（validateRealtimeEndpoint 的三条规则）是报告 B8 点名要求的那三条；
 * 后两组覆盖同一文件内同样零覆盖的相邻导出，属补充项。
 *
 * 断言值全部是 `node --experimental-strip-types` 逐条打印出来的真实返回值，不是按
 * `URL.toString()` 规则推断的——`validateRealtimeEndpoint` 先 `replace(/\/$/, "")`
 * 再 `new URL().toString()`，尾斜杠行为并不一致（`https://api.x/v1/realtime` 返回无尾斜杠，
 * `http://localhost:1` 返回 `http://localhost:1/`）。
 */

function settings(
	overrides: Partial<QuyuanRealtimeProviderSettings> = {}
): QuyuanRealtimeProviderSettings {
	return {
		quyuanRealtimeProviderKind: "dashscope",
		quyuanRealtimeEndpoint: "",
		quyuanRealtimeSecretRef: "",
		quyuanRealtimeWorkspaceId: "",
		quyuanRealtimeRegion: "cn-beijing",
		quyuanRealtimeModel: "qwen3.5-omni-flash-realtime",
		quyuanRealtimeVoice: "Tina",
		...overrides,
	};
}

describe("validateRealtimeEndpoint", () => {
	it("passes https endpoints through unchanged", () => {
		expect(validateRealtimeEndpoint("https://api.x/v1/realtime"))
			.toBe("https://api.x/v1/realtime");
	});

	it("rejects plain http to a non-loopback host", () => {
		expect(() => validateRealtimeEndpoint("http://evil.x/v1")).toThrow("HTTPS 或 loopback");
	});

	it("allows the two documented loopback hosts over plain http", () => {
		expect(validateRealtimeEndpoint("http://localhost:8080/x")).toBe("http://localhost:8080/x");
		expect(validateRealtimeEndpoint("http://127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080/x");
	});

	it("rejects credentials embedded in the URL", () => {
		expect(() => validateRealtimeEndpoint("https://user:pw@api.x/v1")).toThrow("userinfo");
		expect(() => validateRealtimeEndpoint("https://user@api.x/v1")).toThrow("userinfo");
	});

	// 报告范围外的建议项（报告全文无「IPv6」/「::1」），计入用例总数但不作为 Q-TES8 的通过门槛。
	it("accepts an IPv6 loopback endpoint and returns a parseable URL", () => {
		// 实测：`new URL("http://[::1]:8080/x").hostname` 是 "[::1]"，与白名单里的裸 "::1"
		// 永不相等，故原实现会误拒合法 loopback。修复后返回 url.toString() 的真实值。
		const result = validateRealtimeEndpoint("http://[::1]:8080/x");
		expect(result).toBe("http://[::1]:8080/x");
		expect(() => new URL(result)).not.toThrow();
	});

	it("keeps the trailing-slash behaviour that toString() produces for a bare port", () => {
		// 逐条打印过的真实值：路径为空时 toString() 补 "/"。
		expect(validateRealtimeEndpoint("http://localhost:1")).toBe("http://localhost:1/");
		// 已有路径时不会多补。
		expect(validateRealtimeEndpoint("https://api.x/v1/realtime/"))
			.toBe("https://api.x/v1/realtime");
	});
});

describe("resolveQuyuanRealtimeSessionConfig", () => {
	it("keeps whitelisted dashscope model and voice as configured", () => {
		expect(resolveQuyuanRealtimeSessionConfig(settings({
			quyuanRealtimeModel: DASHSCOPE_REALTIME_MODELS[1],
			quyuanRealtimeVoice: "Ethan",
		}))).toEqual({
			kind: "dashscope",
			model: DASHSCOPE_REALTIME_MODELS[1],
			voice: "Ethan",
			// Q-ARC9：百炼恒有转写模型。
			transcriptionModel: "qwen3-asr-flash-realtime",
		});
	});

	it("falls back to the first whitelisted model and Tina for off-list dashscope values", () => {
		expect(resolveQuyuanRealtimeSessionConfig(settings({
			quyuanRealtimeModel: "not-a-qwen-model",
			quyuanRealtimeVoice: "unknown-voice",
		}))).toMatchObject({
			kind: "dashscope",
			model: DASHSCOPE_REALTIME_MODELS[0],
			voice: "Tina",
		});
	});

	it("validates custom-endpoint model names and normalizes the voice", () => {
		expect(() => resolveQuyuanRealtimeSessionConfig(settings({
			quyuanRealtimeProviderKind: "openai-compatible",
			quyuanRealtimeModel: "bad model",
		}))).toThrow("自定义 Realtime 模型名称无效");
		expect(resolveQuyuanRealtimeSessionConfig(settings({
			quyuanRealtimeProviderKind: "openai-compatible",
			quyuanRealtimeModel: "gpt-4o-realtime-preview",
			quyuanRealtimeVoice: "",
		}))).toMatchObject({ model: "gpt-4o-realtime-preview", voice: "alloy" });
	});

	it("strips control characters from the voice and truncates it to 64 chars", () => {
		const resolved = resolveQuyuanRealtimeSessionConfig(settings({
			quyuanRealtimeProviderKind: "openai-compatible",
			quyuanRealtimeModel: "gpt-4o-realtime-preview",
			quyuanRealtimeVoice: `a\r\n\0${"b".repeat(80)}`,
		}));
		expect(resolved.voice).toBe("a" + "b".repeat(63));
		expect(resolved.voice).toHaveLength(64);
	});

	// Q-ARC9：自定义端点的转写模型由设置决定；空就是空，由面板决定拒绝启动。
	it("returns the configured transcription model for custom endpoints, empty when unset", () => {
		expect(resolveQuyuanRealtimeSessionConfig(settings({
			quyuanRealtimeProviderKind: "openai-compatible",
			quyuanRealtimeModel: "gpt-4o-realtime-preview",
			quyuanRealtimeTranscriptionModel: "  x-asr  ",
		})).transcriptionModel).toBe("x-asr");
		expect(resolveQuyuanRealtimeSessionConfig(settings({
			quyuanRealtimeProviderKind: "openai-compatible",
			quyuanRealtimeModel: "gpt-4o-realtime-preview",
		})).transcriptionModel).toBe("");
	});
});

describe("provider kind normalization, ids and secret refs", () => {
	it("keeps only the one supported custom kind and normalizes everything else to dashscope", () => {
		expect(normalizeRealtimeProviderKind("openai-compatible")).toBe("openai-compatible");
		expect(normalizeRealtimeProviderKind("dashscope")).toBe("dashscope");
		expect(normalizeRealtimeProviderKind("something-else")).toBe("dashscope");
		expect(normalizeRealtimeProviderKind("")).toBe("dashscope");
	});

	it("derives the provider id from the normalized kind", () => {
		expect(quyuanRealtimeProviderId(settings())).toBe("aliyun-qwen-realtime");
		expect(quyuanRealtimeProviderId(settings({
			quyuanRealtimeProviderKind: "openai-compatible",
		}))).toBe("custom-openai-compatible-realtime");
	});

	it("falls back to the default custom secret reference and always uses aliyunApiKey for dashscope", () => {
		expect(quyuanRealtimeSecretRef(settings())).toBe("aliyunApiKey");
		expect(quyuanRealtimeSecretRef(settings({
			quyuanRealtimeProviderKind: "openai-compatible",
			quyuanRealtimeSecretRef: "",
		}))).toBe("quyuan-realtime-key");
		expect(quyuanRealtimeSecretRef(settings({
			quyuanRealtimeProviderKind: "openai-compatible",
			quyuanRealtimeSecretRef: "my-ref",
		}))).toBe("my-ref");
	});

	it("exposes exactly the two provider kinds with non-empty labels", () => {
		expect(REALTIME_PROVIDER_KINDS.map((kind) => kind.id))
			.toEqual(["dashscope", "openai-compatible"]);
		for (const kind of REALTIME_PROVIDER_KINDS) {
			expect(kind.label.length).toBeGreaterThan(0);
			expect(kind.description.length).toBeGreaterThan(0);
		}
	});
});
