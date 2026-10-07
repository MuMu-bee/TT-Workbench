// 上下文用量表：把各运行时的 usage.updated 载荷统一成「已用 token / 上下文窗口」。
// 复用 Claudian 视觉 ABI（.claudian-context-meter），行为由 TALOS 自行实现（D-TLP-042）。
// 窗口大小拿不到时只显示 token 数，不推算占比；累计口径的读数标为「约」。
import type { AgentEvent } from "../contracts/agent-events";

export interface ContextUsage {
	usedTokens: number;
	windowTokens: number | null;
	/** 读数为整回合累计（可能高于当前上下文），展示时标注「约」。 */
	approximate: boolean;
}

const WARNING_RATIO = 0.8;

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function num(...values: unknown[]): number {
	return values.reduce<number>((sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? value : 0), 0);
}

function positive(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function usageResult(usedTokens: number, windowTokens: number | null, approximate: boolean): ContextUsage | null {
	return usedTokens > 0 ? { usedTokens, windowTokens, approximate } : null;
}

export function contextUsageFromEvent(event: AgentEvent): ContextUsage | null {
	if (event.type !== "usage.updated") return null;
	const payload = record(event.payload) ?? {};

	// Codex app-server: tokenUsage.last 为最近一回合的提示规模，并带 modelContextWindow
	const tokenUsage = record(payload.tokenUsage);
	if (tokenUsage) {
		const last = record(tokenUsage.last) ?? record(tokenUsage.total) ?? {};
		return usageResult(num(last.inputTokens), positive(tokenUsage.modelContextWindow), false);
	}

	// Claude Agent SDK: 结果消息的 usage 为整回合累计；modelUsage 内带各模型 contextWindow
	const claudeUsage = record(payload.usage);
	if (claudeUsage && ("input_tokens" in claudeUsage || "cache_read_input_tokens" in claudeUsage)) {
		const used = num(claudeUsage.input_tokens, claudeUsage.cache_read_input_tokens, claudeUsage.cache_creation_input_tokens);
		const windows = Object.values(record(payload.modelUsage) ?? {})
			.map((model) => positive(record(model)?.contextWindow))
			.filter((value): value is number => value !== null);
		return usageResult(used, windows.length ? Math.max(...windows) : null, true);
	}

	// OhMyPi: message.usage（input / cacheRead / cacheWrite），没有窗口信息
	if (claudeUsage) {
		return usageResult(num(claudeUsage.input, claudeUsage.cacheRead, claudeUsage.cacheWrite), null, false);
	}

	// 直连 API：inputTokens / outputTokens
	return usageResult(num(payload.inputTokens), null, false);
}

export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return String(Math.round(tokens));
}

export interface ContextMeterView {
	ratio: number | null;
	label: string;
	tooltip: string;
	warning: boolean;
}

export function describeContextUsage(usage: ContextUsage): ContextMeterView {
	const prefix = usage.approximate ? "约 " : "";
	if (!usage.windowTokens) {
		return {
			ratio: null,
			label: `${prefix}${formatTokens(usage.usedTokens)}`,
			tooltip: `上下文 ${prefix}${formatTokens(usage.usedTokens)} tokens（窗口大小未知）`,
			warning: false,
		};
	}
	const ratio = Math.min(1, usage.usedTokens / usage.windowTokens);
	const percent = Math.round(ratio * 100);
	return {
		ratio,
		label: `${percent}%`,
		tooltip: `上下文 ${prefix}${formatTokens(usage.usedTokens)} / ${formatTokens(usage.windowTokens)} tokens`,
		warning: ratio > WARNING_RATIO,
	};
}

const SVG_NS = "http://www.w3.org/2000/svg";
const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export class ContextMeter {
	readonly el: HTMLElement;
	private readonly fill: SVGCircleElement;
	private readonly percent: HTMLElement;

	constructor(doc: Document) {
		this.el = doc.createElement("div");
		this.el.className = "claudian-context-meter";
		this.el.setAttribute("role", "status");
		const gauge = doc.createElement("div");
		gauge.className = "claudian-context-meter-gauge";
		const svg = doc.createElementNS(SVG_NS, "svg");
		svg.setAttribute("viewBox", "0 0 16 16");
		const ring = (cls: string) => {
			const circle = doc.createElementNS(SVG_NS, "circle");
			circle.setAttribute("class", cls);
			circle.setAttribute("cx", "8");
			circle.setAttribute("cy", "8");
			circle.setAttribute("r", String(RADIUS));
			circle.setAttribute("fill", "none");
			circle.setAttribute("stroke-width", "2");
			svg.appendChild(circle);
			return circle;
		};
		ring("claudian-meter-bg");
		this.fill = ring("claudian-meter-fill");
		this.fill.setAttribute("stroke-dasharray", String(CIRCUMFERENCE));
		this.fill.setAttribute("transform", "rotate(-90 8 8)");
		gauge.appendChild(svg);
		this.percent = doc.createElement("span");
		this.percent.className = "claudian-context-meter-percent";
		this.el.append(gauge, this.percent);
		this.update(null);
	}

	update(usage: ContextUsage | null): void {
		this.el.hidden = usage === null;
		if (!usage) return;
		const view = describeContextUsage(usage);
		this.el.classList.toggle("warning", view.warning);
		this.el.dataset.tooltip = view.tooltip;
		this.el.setAttribute("aria-label", view.tooltip);
		this.percent.textContent = view.label;
		this.fill.setAttribute("stroke-dashoffset", String(CIRCUMFERENCE * (1 - (view.ratio ?? 0))));
	}
}
