import type { RuntimeProbe } from "../contracts/runtime-adapter";
import type { OhMyPiRpcPort } from "../adapters/ohmypi/ohmypi-rpc-adapter";
import type { ProtocolFrame } from "../adapters/shared/protocol-frame";
import type { OmpRpcConnection, OmpRpcFrame } from "./omp-rpc-connection";

function protocolFrame(frame: OmpRpcFrame): ProtocolFrame {
	return { id: frame.id, method: frame.type, params: frame };
}

export class OhMyPiProcessPort implements OhMyPiRpcPort {
	constructor(private readonly connection: OmpRpcConnection, private readonly probeRuntime: (signal?: AbortSignal) => Promise<RuntimeProbe>) {}
	probe(signal?: AbortSignal) { return this.probeRuntime(signal); }
	request<T>(method: string, params: Record<string, unknown>) { return this.connection.request<T>(method, params); }
	async *prompt(params: Record<string, unknown>, signal?: AbortSignal): AsyncIterable<ProtocolFrame> {
		const frames = this.connection.subscribe();
		// Q-QUA11：白名单式挑字段会把 `params.images` 静默丢掉（上游 ohmypi-rpc-adapter.ts:137-139
		// 确实构造了 images，且声明 input.image: "native"）。这里改为整体透传，
		// 只把工作台内部的 `text` 键改名成 RPC 的 `message` 并从帧里删掉，
		// 其余键（images / streamingBehavior / 未来新增的）原样进帧。
		const body: Record<string, unknown> = { ...params, message: params.text };
		delete body.text;
		await this.connection.request("prompt", body);
		let activeRun = false;
		for await (const frame of frames) {
			if (signal?.aborted) break;
			if (!activeRun) {
				if (frame.type !== "agent_start") continue;
				activeRun = true;
			}
			yield protocolFrame(frame);
			if (frame.type === "agent_end") break;
		}
	}
	async respond(requestId: string, response: Record<string, unknown>) { await this.connection.respond(requestId, response); }
	async abort() { await this.connection.request("abort"); }
	close() { return this.connection.close(); }
}
