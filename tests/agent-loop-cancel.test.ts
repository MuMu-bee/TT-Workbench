import { describe, expect, it } from "vitest";
import {
	AgentLoop,
	type AgentToolRunner,
	type ModelClient,
	type StreamHandlers,
} from "../src/jarvis/agent/loop";
import type {
	JarvisEvents,
	ResultEvent,
	ToolUseEvent,
} from "../src/jarvis/engine-types";
import type { ToolOutcome } from "../src/jarvis/agent/vault-tools";

/** 只报一次 cancelled 的桩模型：模拟用户在流式响应中被取消。 */
class CancellingModel implements ModelClient {
	pushUser(): void {}
	pushToolResults(): void {}
	abort(): void {}

	async stream(handlers: StreamHandlers): Promise<void> {
		handlers.onDone("cancelled");
	}
}

/** 正常终态文本的桩模型，用来确认未取消路径行为不变。 */
class EndingModel implements ModelClient {
	pushUser(): void {}
	pushToolResults(): void {}
	abort(): void {}

	async stream(handlers: StreamHandlers): Promise<void> {
		handlers.onTextDelta("done");
		handlers.onDone("end");
	}
}

function fixture() {
	const results: ResultEvent[] = [];
	const errors: Error[] = [];
	const busy: boolean[] = [];
	const tools: ToolUseEvent[] = [];
	const events: JarvisEvents = {
		onTextDelta: () => {},
		onResult: (result) => results.push(result),
		onError: (error) => errors.push(error),
		onBusyChange: (value) => busy.push(value),
		onToolUse: (call) => tools.push(call),
	};
	const runner: AgentToolRunner = {
		async run(): Promise<ToolOutcome> {
			throw new Error("取消场景不应执行工具");
		},
	};
	return { results, errors, busy, tools, events, runner };
}

describe("AgentLoop cancellation", () => {
	it("does not record a cancelled turn as a successful result", async () => {
		const state = fixture();
		const loop = new AgentLoop(
			new CancellingModel(),
			state.runner,
			state.events
		);

		await loop.turn({ text: "取消这一轮" });

		// 取消不得被记成 isError:false 的成功回合
		expect(state.results).toHaveLength(0);
		// 取消不是失败面：不走 onError
		expect(state.errors).toHaveLength(0);
		// UI 仍在 finally 里收回 busy，不会卡在「进行中」
		expect(state.busy).toEqual([true, false]);
		// stop === "cancelled" 时连工具都不该被派发
		expect(state.tools).toHaveLength(0);
	});

	it("still reports one result and toggles busy on a normal end", async () => {
		const state = fixture();
		const loop = new AgentLoop(new EndingModel(), state.runner, state.events);

		await loop.turn({ text: "正常收尾" });

		expect(state.results).toHaveLength(1);
		expect(state.results[0]).toMatchObject({ isError: false });
		expect(state.errors).toHaveLength(0);
		expect(state.busy).toEqual([true, false]);
	});
});
