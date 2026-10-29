import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAgentEvent, type AgentEvent } from "../src/agent-workbench/contracts/agent-events";
import { contextUsageFromEvent, describeContextUsage, formatTokens } from "../src/agent-workbench/ui/context-usage";

function usageEvent(runtimeId: AgentEvent["runtimeId"], payload: Record<string, unknown>): AgentEvent {
	return createAgentEvent({
		eventId: "e1",
		conversationId: "c1",
		turnId: "t1",
		runtimeId,
		type: "usage.updated",
		timestamp: "2026-10-08T00:00:00.000Z",
		payload,
	});
}

describe("context usage meter", () => {
	it("reads codex-style last-turn input against the model context window", () => {
		const usage = contextUsageFromEvent(usageEvent("ohmypi", {
			tokenUsage: { total: { inputTokens: 90_000 }, last: { inputTokens: 64_000 }, modelContextWindow: 256_000 },
		}));
		expect(usage).toEqual({ usedTokens: 64_000, windowTokens: 256_000, approximate: false });
		expect(describeContextUsage(usage!)).toMatchObject({ label: "25%", warning: false });
	});

	it("marks claude-style turn totals as approximate and caps the ring at 100%", () => {
		const usage = contextUsageFromEvent(usageEvent("ohmypi", {
			usage: { input_tokens: 30_000, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 40_000, output_tokens: 900 },
			modelUsage: { "claude-sonnet": { contextWindow: 200_000 } },
		}));
		expect(usage).toEqual({ usedTokens: 220_000, windowTokens: 200_000, approximate: true });
		expect(describeContextUsage(usage!)).toMatchObject({ ratio: 1, label: "100%", warning: true });
		expect(describeContextUsage(usage!).tooltip).toBe("上下文 约 220.0k / 200.0k tokens");
	});

	it("shows token counts without a ratio when the window is unknown", () => {
		const ohmypi = contextUsageFromEvent(usageEvent("ohmypi", { usage: { input: 1_200, cacheRead: 300, cacheWrite: 0, output: 50 } }));
		expect(ohmypi).toEqual({ usedTokens: 1_500, windowTokens: null, approximate: false });
		expect(describeContextUsage(ohmypi!)).toMatchObject({ ratio: null, label: "1.5k", tooltip: "上下文 1.5k tokens（窗口大小未知）" });
		const api = contextUsageFromEvent(usageEvent("api" as AgentEvent["runtimeId"], { inputTokens: 800, outputTokens: 20 }));
		expect(api).toEqual({ usedTokens: 800, windowTokens: null, approximate: false });
	});

	it("ignores other events and empty usage", () => {
		expect(contextUsageFromEvent({ ...usageEvent("ohmypi", {}), type: "assistant.final" })).toBeNull();
		expect(contextUsageFromEvent(usageEvent("ohmypi", { tokenUsage: { last: { inputTokens: 0 } } }))).toBeNull();
	});

	it("formats token counts compactly", () => {
		expect([formatTokens(950), formatTokens(12_340), formatTokens(1_250_000)]).toEqual(["950", "12.3k", "1.3M"]);
	});

	it("really hides the meter when there is no reading", () => {
		const css = readFileSync(fileURLToPath(new URL("../src/agent-workbench/ui/styles/components/context-footer.css", import.meta.url)), "utf8");
		expect(css).toMatch(/\.claudian-context-meter\[hidden\] \{\s*display: none;/);
	});
});
