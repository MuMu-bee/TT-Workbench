import { describe, expect, it } from "vitest";
import { OhMyPiRpcAdapter } from "../src/agent-workbench/adapters/ohmypi/ohmypi-rpc-adapter";
import { OhMyPiProcessPort } from "../src/agent-workbench/transports/ohmypi-process-port";
import type { OmpRpcConnection, OmpRpcFrame } from "../src/agent-workbench/transports/omp-rpc-connection";

/**
 * Q-QUA11：ompypi 端口的传输层专属测试。
 *
 * 现状（改动前）：`grep -rn "OhMyPiRpcAdapter\|OhMyPiProcessPort" tests/` 退出码 1、零命中；
 * `OhMyPiProcessPort.prompt` 是白名单式挑字段，只发 `{ message, streamingBehavior }`，
 * 上游 `ohmypi-rpc-adapter.ts:137-139` 构造的 `params.images` 被静默丢弃——
 * 图片一解禁就是「消息已发、模型没收到图」。本轮按方案走「真转发」这一支
 * （真实 omp 18.2.8 实测能接收并把图片放进 user message 的 content blocks）。
 *
 * 断言口径照方案 step 4：
 *  a）含 1 张合法图片的 turn，prompt params 的 images 深等于预期形状；
 *  b）不含图片的 turn，prompt params 连 `images` 键都没有（`hasOwnProperty === false`）；
 *  c）非法 dataUrl 在发 RPC 之前抛错，`sent` 里没有 prompt 调用。
 */

interface SentCall {
	method: string;
	params: Record<string, unknown> | undefined;
}

/**
 * stubConnection：只实现 OmpRpcConnection 的五个成员。
 * `request` 把 (method, params) 推进 `sent`；`subscribe` 依次吐
 * agent_start → message_end（带 text）→ agent_end，让 `prompt` 的帧循环自然结束。
 */
function stubConnection(sent: SentCall[]): OmpRpcConnection {
	async function* frames(): AsyncGenerator<OmpRpcFrame> {
		yield { type: "agent_start" };
		yield { type: "message_end", params: { message: { content: [{ type: "text", text: "ok" }] } } };
		yield { type: "agent_end" };
	}
	return {
		ready: async () => undefined,
		request: async <T>(method: string, params?: Record<string, unknown>) => {
			sent.push({ method, params });
			// new_session / get_state 是 createSession 的两次请求；返回最小合法形状。
			if (method === "new_session") return { cancelled: false } as T;
			if (method === "get_state") return { sessionId: "session-1" } as T;
			return {} as T;
		},
		respond: async () => undefined,
		subscribe: () => frames(),
		close: async () => undefined,
	};
}

async function adapterFixture() {
	const sent: SentCall[] = [];
	const adapter = new OhMyPiRpcAdapter(
		// RuntimeProbe 必须带 runtimeId（契约要求），sandboxReady 是 async（adapter 会 await）。
		new OhMyPiProcessPort(stubConnection(sent), async () => ({ runtimeId: "ohmypi" as const, status: "ready" as const })),
		async () => true,
	);
	await adapter.createSession({ conversationId: "conversation-1", vaultRoot: "/synthetic/vault" });
	return { adapter, sent };
}

function promptParams(sent: SentCall[]): Record<string, unknown> | undefined {
	return sent.find((call) => call.method === "prompt")?.params;
}

const pngBlock = {
	type: "image" as const,
	id: "img-1",
	name: "chart.png",
	mimeType: "image/png" as const,
	dataUrl: "data:image/png;base64,AAAA",
};

describe("OhMyPiProcessPort prompt forwarding", () => {
	it("forwards images to the RPC prompt frame instead of dropping them", async () => {
		const { adapter, sent } = await adapterFixture();
		const events = [];
		for await (const event of adapter.send({
			conversationId: "conversation-1",
			turnId: "turn-image",
			text: "看图",
			input: [pngBlock],
			workflow: "plan",
		})) events.push(event);
		const params = promptParams(sent);
		expect(params?.images).toEqual([
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);
		// 显式断言「键存在」：只看深等会在键缺失时也通过（undefined !== [...]），
		// 但方案要求 hasOwnProperty 为 true，才排除掉「值是 undefined」的伪通过。
		expect(Object.prototype.hasOwnProperty.call(params, "images")).toBe(true);
		// 工作台内部键改名成 RPC 的 message，不得把 `text` 一起泄进帧。
		expect(params?.message).toBe("看图");
		expect(Object.prototype.hasOwnProperty.call(params, "text")).toBe(false);
		await adapter.dispose();
	});

	it("omits the images key entirely when the turn has no image", async () => {
		const { adapter, sent } = await adapterFixture();
		const events = [];
		for await (const event of adapter.send({
			conversationId: "conversation-1",
			turnId: "turn-text",
			text: "纯文字",
			input: [{ type: "text", text: "纯文字" }],
			workflow: "plan",
		})) events.push(event);
		const params = promptParams(sent);
		expect(Object.prototype.hasOwnProperty.call(params, "images")).toBe(false);
		expect(params?.message).toBe("纯文字");
		await adapter.dispose();
	});

	it("rejects an invalid data URL before any prompt call reaches the RPC", async () => {
		const { adapter, sent } = await adapterFixture();
		const mismatched = {
			...pngBlock,
			// mimeType 与 dataUrl 前缀不符：decodeRuntimeImages 的第一道校验。
			mimeType: "image/jpeg" as const,
		};
		await expect(async () => {
			const events = adapter.send({
				conversationId: "conversation-1",
				turnId: "turn-invalid",
				text: "非法图",
				input: [mismatched],
				workflow: "plan",
			});
			// 只关心它抛错，事件内容不重要
			for await (const event of events) void event;
		}).rejects.toThrow("图片附件格式无效");
		expect(sent.some((call) => call.method === "prompt")).toBe(false);
		await adapter.dispose();
	});
});
