import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlSecurityAuditSink } from "../src/agent-workbench/security/jsonl-security-audit-sink";
import { ContextHandoffService } from "../src/agent-workbench/core/context-handoff-service";
import type { SecurityAuditRecord } from "../src/agent-workbench/security/security-audit";
import type { AgentEvent } from "../src/agent-workbench/contracts/agent-events";

/**
 * Q-TES7 第 5 步：为报告点名的两个 0% 覆盖的合规模块各补一条行为用例
 * （`security/jsonl-security-audit-sink.ts`、`core/context-handoff-service.ts`）。
 * 断言落在可观察行为上（落盘内容 / 信封字段裁剪），不是对源码做文本断言。
 */

const root = fileURLToPath(new URL("../", import.meta.url));

const created: string[] = [];

afterEach(async () => {
	for (const directory of created.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

/**
 * 报告给出的「217 个文件中 54 个 0% 行覆盖」里，安全/合规模块占了两项
 * （`security/jsonl-security-audit-sink.ts`、`core/context-handoff-service.ts`）。
 * 这条断言直接读 `coverage-summary.json`，把「security 目录下 0% 文件数为 0」钉死。
 *
 * 覆盖率报告只在 `npx vitest run --coverage` 时生成，普通 `npm test` 下没有——
 * 因此这里跳过而不是让普通测试因此报错，并在 CI 的 Coverage step 里真正生效。
 */
function securityZeroLineFiles(): string[] | null {
	const summaryPath = path.join(root, "coverage", "coverage-summary.json");
	if (!existsSync(summaryPath)) return null;
	const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as Record<
		string,
		{ lines: { pct: number } }
	>;
	return Object.entries(summary)
		.filter(([file, entry]) => file !== "total" && entry.lines.pct === 0)
		.map(([file]) => file.split("\\").join("/"))
		.filter((file) => /src\/agent-workbench\/security\//.test(file));
}

async function scratchVault(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "talos-audit-sink-"));
	created.push(directory);
	return directory;
}

function auditRecord(overrides: Partial<SecurityAuditRecord> = {}): SecurityAuditRecord {
	return {
		recordedAt: "2026-10-25T00:00:00.000Z",
		action: "write",
		decision: "allow",
		reasonCode: "vault-inside-read",
		conversationId: "c1",
		targetSummaries: ["notes/a.md"],
		...overrides,
	} as SecurityAuditRecord;
}

describe("JsonlSecurityAuditSink", () => {
	it("appends each record as one JSONL line under .talos/agent-workbench/v1 and keeps prior lines", async () => {
		const vaultRoot = await scratchVault();
		const sink = new JsonlSecurityAuditSink(vaultRoot);

		await sink.append(auditRecord({ reasonCode: "first" }));
		await sink.append(auditRecord({ reasonCode: "second" }));

		const file = path.join(vaultRoot, ".talos", "agent-workbench", "v1", "security-audit.jsonl");
		const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		const parsed = lines.map((line) => JSON.parse(line) as { reasonCode: string; action: string });
		// 轮转不是截断：两次追加都在，且各自是可解析的完整 JSON 行。
		expect(parsed.map((record) => record.reasonCode)).toEqual(["first", "second"]);
		expect(parsed.every((record) => record.action === "write")).toBe(true);
	});
});

function event(overrides: Record<string, unknown>): AgentEvent {
	return {
		eventId: "e1",
		conversationId: "c1",
		turnId: "t1",
		timestamp: "2026-10-25T00:00:00.000Z",
		runtimeId: "ohmypi",
		type: "user.message",
		payload: {},
		...overrides,
	} as AgentEvent;
}

describe("ContextHandoffService", () => {
	it("builds an envelope with the last 8 non-system messages, tool summaries and vault-relative refs only", () => {
		const service = new ContextHandoffService();
		// projectMessages 按 turnId 聚合同一回合的 assistant 片段，故每条消息给独立 turnId。
		const messages: AgentEvent[] = Array.from({ length: 10 }, (_, index) => event({
			eventId: `m${index}`,
			turnId: `turn${index}`,
			type: index % 2 === 0 ? "user.message" : "assistant.final",
			payload: { text: `第 ${index} 条` },
		}));
		const system = event({ eventId: "sys", turnId: "sys", type: "runtime.status", payload: { text: "系统事件" } });
		const tools = Array.from({ length: 6 }, (_, index) => event({
			eventId: `tool${index}`,
			turnId: `tool${index}`,
			type: "tool.finished",
			payload: { summary: `摘要 ${index}` },
		}));
		// tool.started 不投影成消息，只用来携带 vaultPath，验证引用过滤。
		const refs = [
			event({ eventId: "r1", turnId: "ref1", type: "tool.started", payload: { vaultPath: "notes/a.md" } }),
			// 绝对路径与 .. 越界引用都不得进信封。
			event({ eventId: "r2", turnId: "ref2", type: "tool.started", payload: { vaultPath: "/abs/path.md" } }),
			event({ eventId: "r3", turnId: "ref3", type: "tool.started", payload: { vaultPath: "../escape.md" } }),
		];

		const envelope = service.create({
			conversationId: "c1",
			fromRuntimeId: "ohmypi",
			toRuntimeId: "ohmypi",
			events: [system, ...messages, ...tools, ...refs],
			goal: "交接目标",
		});

		expect(envelope.schemaVersion).toBe(1);
		expect(envelope.conversationId).toBe("c1");
		expect(envelope.recentMessages).toHaveLength(8);
		// 窗口取最后 8 条（不足 9 条直接取末尾），且不含 system 角色。
		expect(envelope.recentMessages.map((message) => message.text)).toEqual([
			"第 2 条", "第 3 条", "第 4 条", "第 5 条",
			"第 6 条", "第 7 条", "第 8 条", "第 9 条",
		]);
		expect(envelope.toolResultSummaries).toEqual(["摘要 2", "摘要 3", "摘要 4", "摘要 5"]);
		expect(envelope.vaultRelativeReferences).toEqual(["notes/a.md"]);
		expect(envelope.lastSyncedEventId).toBe("r3");
		expect(envelope.goal).toBe("交接目标");
	});
});

describe("security/** zero-coverage guard (Q-TES7)", () => {
	it("leaves no security module at 0% line coverage in the generated coverage summary", () => {
		const zero = securityZeroLineFiles();
		if (zero === null) {
			// 没跑过 --coverage：报告文件不存在，跳过（CI 的 Coverage step 会真正生成它）。
			return;
		}
		expect(zero).toEqual([]);
	});
});
