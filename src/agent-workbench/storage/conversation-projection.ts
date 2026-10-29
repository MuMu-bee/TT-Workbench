import type { AgentEvent } from "../contracts/agent-events";
import type { RuntimeHistoryItem, RuntimeId } from "../contracts/runtime-adapter";

export interface ProjectedMessage {
	role: "user" | "assistant" | "system";
	text: string;
	eventId: string;
}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }

function hasNonEmptyValue(value: unknown): boolean {
	if (typeof value === "string") return value.trim().length > 0;
	if (Array.isArray(value)) return value.some(hasNonEmptyValue);
	if (value && typeof value === "object") return Object.values(value).some(hasNonEmptyValue);
	return false;
}

export function hasMeaningfulHandoffPayload(payload: unknown): boolean {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
	const value = payload as Record<string, unknown>;
	return [
		value.goal,
		value.recentMessages,
		value.incompleteTasks,
		value.toolResultSummaries,
		value.vaultRelativeReferences,
	].some(hasNonEmptyValue);
}

export function hasMeaningfulHandoffContext(event: AgentEvent): boolean {
	return event.type === "handoff.created" && hasMeaningfulHandoffPayload(event.payload);
}

/**
 * 把最近一条「切到 runtimeId」的 handoff.created 信封投影成回合历史。
 *
 * 边界：`handoff.created` 的 `event.runtimeId` 是 `fromRuntimeId`
 * （workbench-conversation-coordinator.ts:135），所以过滤必须看 `payload.toRuntimeId`。
 * 本函数只修数据通路：`ohmypi` 适配器不消费 `turn.history`，现网单运行时下
 * 用户可见行为不变；它让 handoff 信封获得唯一读取方。
 */
export function projectHandoffHistory(events: AgentEvent[], runtimeId: RuntimeId): RuntimeHistoryItem[] {
	const event = [...events].reverse().find((candidate) =>
		hasMeaningfulHandoffContext(candidate) && candidate.payload.toRuntimeId === runtimeId
	);
	if (!event) return [];
	const recent = event.payload.recentMessages;
	if (!Array.isArray(recent)) return [];
	const history: RuntimeHistoryItem[] = [];
	for (const entry of recent) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const message = entry as Record<string, unknown>;
		const role = message.role;
		const value = message.text;
		if (role !== "user" && role !== "assistant") continue;
		if (typeof value !== "string" || !value.trim()) continue;
		history.push({ role, text: value });
	}
	return history;
}

export function projectMessages(events: AgentEvent[]): ProjectedMessage[] {
	const messages: ProjectedMessage[] = [];
	const assistantByTurn = new Map<string, ProjectedMessage>();
	for (const event of events) {
		if (event.type === "user.message") {
			messages.push({ role: "user", text: text(event.payload.text), eventId: event.eventId });
		}
		if (event.type === "assistant.delta" || event.type === "assistant.final") {
			let message = assistantByTurn.get(event.turnId);
			if (!message) {
				message = { role: "assistant", text: "", eventId: event.eventId };
				assistantByTurn.set(event.turnId, message);
				messages.push(message);
			}
			const content = text(event.payload.text);
			message.text = event.type === "assistant.final" ? content : `${message.text}${content}`;
		}
		if (event.type === "handoff.created" && hasMeaningfulHandoffContext(event)) {
			messages.push({ role: "system", text: "Runtime handoff", eventId: event.eventId });
		}
	}
	return messages;
}
