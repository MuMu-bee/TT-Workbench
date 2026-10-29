import { describe, expect, it, vi } from "vitest";
import { DirectApiRuntimeAdapter } from "../src/agent-workbench/adapters/api/direct-api-runtime-adapter";
import type { ProviderProfile } from "../src/agent-workbench/contracts/provider-profile";
import { DesktopRuntimeFactory } from "../src/agent-workbench/discovery/desktop-runtime-factory";

const profile: ProviderProfile = {
	id: "openai-compatible",
	displayName: "OpenAI-compatible API",
	// RuntimeId 契约已收窄为 "ohmypi"（runtime-adapter.ts:9）；profile 也只能挂它。
	runtimeId: "ohmypi",
	protocol: "openai-chat",
	endpoint: "https://gateway.test/v1",
	models: ["model-x"],
	secretRef: "talos-openai-api-key",
	enabled: true,
};

function sse(text: string): Response {
	return new Response([
		`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}`,
		"data: [DONE]",
		"",
	].join("\n\n"), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/**
 * 旧版本落盘的 provider profile 形状：`runtimeId` 仍是历史字符串。
 *
 * 契约已把它收窄成 `RuntimeId = "ohmypi"`（runtime-adapter.ts:9），所以这种数据在
 * 类型层面已不可能由正常构造产生——它只会从磁盘 JSON 反序列化得到。这里显式命名这个
 * 「磁盘形态」，供「不匹配守卫仍生效」那条断言使用；其余用例一律走合法 `profile`。
 */
function legacyDiskProfile(): ProviderProfile {
	const disk: unknown = JSON.parse(JSON.stringify({ ...profile, runtimeId: "codex" }));
	return disk as ProviderProfile;
}

describe("DirectApiRuntimeAdapter", () => {
	it("constructs the direct route without runtime discovery, sandbox probing or child processes", async () => {
		const discovery = { probe: vi.fn(() => {
			throw new Error("native discovery must not run");
		}) };
		const sandbox = {
			availability: vi.fn(() => {
				throw new Error("sandbox probe must not run");
			}),
			assertAvailable: vi.fn(),
			prepare: vi.fn(),
		};
		const factory = new DesktopRuntimeFactory(
			discovery as never,
			sandbox as never,
			() => "synthetic-secret",
			async () => sse("factory reply"),
		);
		// 1.1.0 之前落盘的 profile 里 runtimeId 还是历史字符串，读取层按未知 runtime 处理
		// （runtime-adapter.ts:5-8）。这里刻意构造「旧版磁盘数据」这一非法落点来验证守卫
		// 仍然生效——契约类型本身已不接受该值，所以此处的一次断言是「模拟反序列化」的
		// 唯一入口，不是绕过类型：正常路径的 profile 仍由上面的 `profile` 常量提供。
		await expect(factory.create("ohmypi", {
			vaultRoot: "C:\\synthetic-vault",
			providerProfile: legacyDiskProfile(),
			approve: async () => "deny",
		})).rejects.toThrow("profile 与 runtime 不匹配");

		const adapter = await factory.create("ohmypi", {
			vaultRoot: "C:\\synthetic-vault",
			providerProfile: profile,
			approve: async () => "deny",
		});
		expect(adapter).toBeInstanceOf(DirectApiRuntimeAdapter);
		expect(discovery.probe).not.toHaveBeenCalled();
		expect(sandbox.availability).not.toHaveBeenCalled();
		expect(sandbox.prepare).not.toHaveBeenCalled();
		await adapter.dispose();
	});

	it("runs a text-only Plan turn without CLI discovery or OS sandbox", async () => {
		const requests: Array<Record<string, unknown>> = [];
		const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const body = init?.body;
			if (typeof body !== "string") throw new Error("expected string body");
			requests.push(JSON.parse(body) as Record<string, unknown>);
			return sse("Windows reply");
		});
		const adapter = new DirectApiRuntimeAdapter({
			profile,
			resolveSecret: () => "synthetic-secret",
			fetcher,
		});
		const binding = await adapter.createSession({
			conversationId: "conversation-1",
			vaultRoot: "C:\\synthetic-vault",
			providerProfileId: profile.id,
		});
		expect(binding).toMatchObject({
			runtimeId: "ohmypi",
			providerProfileId: profile.id,
			protocolVersion: "talos-direct-api-v1",
		});
		const events = [];
		for await (const event of adapter.send({
			conversationId: "conversation-1",
			turnId: "turn-1",
			text: "new question",
			history: [{ role: "user", text: "prior question" }],
			workflow: "plan",
		})) events.push(event);
		expect(events.map((event) => event.type)).toEqual([
			"assistant.delta",
			"assistant.final",
			"turn.finished",
		]);
		expect(events[1]?.payload).toEqual({ text: "Windows reply" });
		expect(requests[0]?.tools).toBeUndefined();
		expect(requests[0]?.messages).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "user", content: "prior question" }),
			expect.objectContaining({ role: "user", content: "new question" }),
		]));
		expect(adapter.capabilities().tools.shell).toBe("unavailable");
		await adapter.dispose();
	});

	it("fails closed in Execute mode without calling the API", async () => {
		const fetcher = vi.fn();
		const adapter = new DirectApiRuntimeAdapter({
			profile,
			resolveSecret: () => "synthetic-secret",
			fetcher,
		});
		await adapter.createSession({
			conversationId: "conversation-1",
			vaultRoot: "C:\\synthetic-vault",
			providerProfileId: profile.id,
		});
		const events = [];
		for await (const event of adapter.send({
			conversationId: "conversation-1",
			turnId: "turn-execute",
			text: "write a file",
			workflow: "execute",
		})) events.push(event);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "error",
			payload: { recoverable: true },
		});
		expect(String(events[0]?.payload.message)).toContain("Plan");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("surfaces protocol errors without a synthesized successful terminal event", async () => {
		const adapter = new DirectApiRuntimeAdapter({
			profile,
			resolveSecret: () => "synthetic-secret",
			fetcher: async () => new Response("<html>bad gateway</html>", {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
		});
		await adapter.createSession({
			conversationId: "conversation-1",
			vaultRoot: "C:\\synthetic-vault",
			providerProfileId: profile.id,
		});
		const events = [];
		for await (const event of adapter.send({
			conversationId: "conversation-1",
			turnId: "turn-error",
			text: "hello",
			workflow: "plan",
		})) events.push(event);
		expect(events.map((event) => event.type)).toEqual(["error"]);
		expect(String(events[0]?.payload.message)).toContain("响应格式不受支持");
	});

	/**
	 * Q-ARC5：tool-skipped 不再被静默丢弃。
	 *
	 * 改动前实测：注入 `{type:"tool-skipped",toolCallId:"tc-1",reason:"review-mode"}` 后输出
	 * 仍为 ["assistant.delta","assistant.final","turn.finished"]、tc-1 完全不出现
	 * （mapEvent 末尾的万能兜底把它与 tool-result/done 一起吞了）。
	 */
	it("surfaces tool-skipped instead of silently dropping it", async () => {
		const adapter = new DirectApiRuntimeAdapter({
			profile,
			resolveSecret: () => "synthetic-secret",
			// 直接注入 provider 事件序列：不经过 HTTP，只验 mapEvent 的映射。
			createProvider: () => ({
				id: profile.id,
				kind: "api",
				async *chat() {
					yield { type: "text" as const, text: "部分输出" };
					yield { type: "tool-skipped" as const, toolCallId: "tc-1", reason: "review-mode" as const };
					yield { type: "done" as const };
				},
				cancel: async () => undefined,
			}),
		});
		await adapter.createSession({
			conversationId: "conversation-1",
			vaultRoot: "C:\\synthetic-vault",
			providerProfileId: profile.id,
		});
		const events = [];
		for await (const event of adapter.send({
			conversationId: "conversation-1",
			turnId: "turn-skipped",
			text: "用工具",
			workflow: "plan",
		})) events.push(event);
		// tc-1 能在输出事件里被检索到（方案给的两个判据任一即可，这里用最直接的检索）。
		expect(JSON.stringify(events.map((event) => event.payload))).toMatch(/tc-1/);
		// 文本与收尾事件仍然照旧产出，说明新增分支没有改变既有语义。
		expect(events.map((event) => event.type)).toEqual([
			"assistant.delta",
			"notice",
			"assistant.final",
			"turn.finished",
		]);
		await adapter.dispose();
	});
});
