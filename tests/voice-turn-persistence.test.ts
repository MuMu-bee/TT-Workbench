import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	App: class {},
	Component: class {
		load(): void {}
		unload(): void {}
	},
	MarkdownRenderer: { render: async () => undefined },
	Notice: class {},
	setIcon: (): void => undefined,
	requestUrl: vi.fn(),
}));

import type { App } from "obsidian";
import type { TalosSettings } from "../src/settings";
import { VoiceSessionStore } from "../src/quyuan/voice-session-store";
import { VoiceSessionCoalescer } from "../src/quyuan/voice-session-coalescer";
import { QuyuanVoicePanel } from "../src/quyuan/voice-panel";
import {
	expectSourceContains,
	expectSourceNotContains,
	withoutImports,
} from "./helpers/source-text";

const root = fileURLToPath(new URL("../", import.meta.url));

function settingsWithSession(): { quyuanVoiceSessionJson: string; jarvisTabsJson: string } {
	return { quyuanVoiceSessionJson: "", jarvisTabsJson: "" };
}

/** 按花括号配对切出一个方法体（不用行号：改写后行号会漂）。 */
function methodBody(source: string, signature: string): string {
	const start = source.indexOf(signature);
	expect(start, `missing ${signature}`).toBeGreaterThan(-1);
	const open = source.indexOf("{", start);
	expect(open).toBeGreaterThan(start);
	let depth = 0;
	let cursor = open;
	while (cursor < source.length) {
		if (source[cursor] === "{") depth += 1;
		else if (source[cursor] === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(open + 1, cursor);
		}
		cursor += 1;
	}
	throw new Error(`unbalanced body for ${signature}`);
}

describe("语音会话持久化：一次回合只落盘一次（Q-PER10）", () => {
	it("真实 VoiceSessionStore 包一层合并器：回合内 3 次写收起 1 次落盘", async () => {
		const settings = settingsWithSession();
		const persist = vi.fn(async () => undefined);
		const coalescer = new VoiceSessionCoalescer(persist);

		// 计数桩：write 只记 dirty，不产生 IO。这与生产接线一致
		// （voice-panel.ts 的 VoiceSessionStore.write 也是写内存 + markDirty）。
		const writes: string[] = [];
		const store = new VoiceSessionStore({
			read: () => settings.quyuanVoiceSessionJson,
			write: (value) => {
				writes.push(value);
				settings.quyuanVoiceSessionJson = value;
				coalescer.markDirty();
			},
		});

		await store.load();
		expect(persist).not.toHaveBeenCalled();

		// 一个真实的最小回合：终稿字幕 + 助手回复 + 任务证据
		await store.appendFinalTranscript({
			id: "voice-user-1",
			role: "user",
			text: "屈原，读一下今天的任务",
			modality: "speech",
			createdAt: 1,
		});
		await store.appendMessage({
			id: "voice-assistant-1",
			role: "assistant",
			text: "今天有三项待办。",
			modality: "speech",
			createdAt: 2,
		});
		await store.recordTaskEvidence({
			taskId: "task-1",
			state: "completed",
			auditEvidence: "只读工具 1 次",
		});

		// 回合内写内存已同步，但落盘次数为 0
		expect(writes).toHaveLength(3);
		expect(persist).not.toHaveBeenCalled();
		expect(settings.quyuanVoiceSessionJson.includes("今天有三项待办。")).toBe(true);

		// 回合边界 flush：一次落盘
		await coalescer.flush();
		expect(persist).toHaveBeenCalledTimes(1);
		expect(coalescer.flushes).toBe(1);
		expect(coalescer.pending).toBe(false);

		// 落盘内容即回合内最后一次快照
		const persisted = JSON.parse(settings.quyuanVoiceSessionJson) as {
			messages: unknown[];
			taskEvidence: unknown[];
		};
		expect(persisted.messages).toHaveLength(2);
		expect(persisted.taskEvidence).toHaveLength(1);
	});

	it("没有待写数据时 flush 不落盘", async () => {
		const persist = vi.fn(async () => undefined);
		const coalescer = new VoiceSessionCoalescer(persist);

		await coalescer.flush();
		expect(persist).not.toHaveBeenCalled();
	});

	it("flush 失败时保留待写标记，交给下一个回合边界重试", async () => {
		let shouldFail = true;
		const persist = vi.fn(async () => {
			if (shouldFail) throw new Error("disk full");
		});
		const onError = vi.fn();
		const coalescer = new VoiceSessionCoalescer(persist, onError);

		coalescer.markDirty();
		await coalescer.flush();

		expect(persist).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(coalescer.pending).toBe(true);

		shouldFail = false;
		await coalescer.flush();
		expect(persist).toHaveBeenCalledTimes(2);
		expect(coalescer.pending).toBe(false);
	});

	it("flush 期间的新写入在同一轮里被补写，不丢", async () => {
		const persisted: number[] = [];
		let sequence = 0;
		const coalescer = new VoiceSessionCoalescer(async () => {
			sequence += 1;
			persisted.push(sequence);
			// 落盘过程中又来了新写：合并器应在本轮再落一次
			if (sequence === 1) coalescer.markDirty();
		});

		coalescer.markDirty();
		await coalescer.flush();

		expect(persisted).toEqual([1, 2]);
		expect(coalescer.pending).toBe(false);
	});
});

describe("语音持久化不再穿透 provider / profile 链（Q-PER10）", () => {
	it("轻量保存只做归一化 + loadData + saveData，不碰 provider 与 profile", () => {
		const source = readFileSync(`${root}src/main.ts`, "utf8");
		const body = methodBody(source, "async saveTalosVoiceSession(): Promise<void> {");

		// 只保留轻量三段
		expect(body.includes("enforceRealtimeVoiceIoSettings(this.talosSettings)")).toBe(true);
		expect(body.includes("await this.loadData()")).toBe(true);
		expect(body.includes("await this.saveData({ ...stored, talos: this.talosSettings })")).toBe(true);
		// 不触发全量保存链的四件事
		for (const forbidden of [
			"saveProviderConfigToVault",
			"syncCodexHarnessEnvironment",
			"syncAgentWorkbenchProviderProfiles",
			"this.talosAskService = null",
			"this.talosProviderFacade = null",
		]) {
			expect(body.includes(forbidden), `light save must not call ${forbidden}`).toBe(false);
		}

		// 反向对照：全量保存仍保留这些调用（证明上面不是空转）
		const fullBody = methodBody(source, "async saveTalosSettings(): Promise<void> {");
		for (const required of [
			"saveProviderConfigToVault",
			"syncCodexHarnessEnvironment",
			"syncAgentWorkbenchProviderProfiles",
			"this.talosAskService = null",
		]) {
			expect(fullBody.includes(required), `full save must still call ${required}`).toBe(true);
		}
	});
});

describe("两个开关仍走全量保存（Q-PER10）", () => {
	it("setVoiceInputMode 与 setVoiceRecognitionEnabled 各调全量 save 1 次、saveSession 0 次", async () => {
		const save = vi.fn(async () => undefined);
		const saveSession = vi.fn(async () => undefined);
		const settings = {
			quyuanVoiceInputMode: "continuous",
			quyuanVoiceRecognitionEnabled: false,
		} as unknown as TalosSettings;
		const panel = new QuyuanVoicePanel(
			{} as App,
			{} as never,
			settings,
			save,
			undefined,
			saveSession
		);
		const drive = panel as unknown as {
			setVoiceInputMode(mode: "continuous" | "push-to-talk"): Promise<void>;
			setVoiceRecognitionEnabled(enabled: boolean): Promise<void>;
		};

		// 两个开关都是 provider 相关设置，必须走全量 save（从而重写 provider.json 与 profile）
		await drive.setVoiceInputMode("push-to-talk");
		expect(save).toHaveBeenCalledTimes(1);
		expect(saveSession).not.toHaveBeenCalled();

		await drive.setVoiceRecognitionEnabled(true);
		expect(save).toHaveBeenCalledTimes(2);
		expect(saveSession).not.toHaveBeenCalled();
	});

	it("this.save?.() 仍恰为 2 处、saveSession 只在构造与会话写路径，且全在实现体内", () => {
		const source = readFileSync(`${root}src/quyuan/voice-panel.ts`, "utf8");
		const inputMode = methodBody(source, "private async setVoiceInputMode(");
		expect(inputMode.includes("if (persist) await this.save?.();")).toBe(true);
		expect(inputMode.includes("saveSession")).toBe(false);

		const recognition = methodBody(
			source,
			"private async setVoiceRecognitionEnabled("
		);
		expect(recognition.includes("if (persist) await this.save?.();")).toBe(true);
		expect(recognition.includes("saveSession")).toBe(false);

		// this.save?.() 仍恰为 2 处（会话写路径已改走合并器，不再走全量保存）
		expect((source.match(/this\.save\?\.\(\)/g) || []).length).toBe(2);
		// saveSession 出现在构造赋值与合并器回调两处
		expect((source.match(/this\.saveSession/g) || []).length).toBeGreaterThanOrEqual(2);
	});

	it("会话写路径改走内存 + markDirty，不再直接 await this.save?.()", () => {
		const source = withoutImports(
			readFileSync(`${root}src/quyuan/voice-panel.ts`, "utf8")
		);
		const start = source.indexOf("this.voiceSessionStore = new VoiceSessionStore({");
		expect(start).toBeGreaterThan(-1);
		const writeStart = source.indexOf("write: (value) => {", start);
		expect(writeStart).toBeGreaterThan(start);
		const writeBody = source.slice(writeStart, source.indexOf("});", writeStart));

		expect(writeBody.includes("this.settings.quyuanVoiceSessionJson = value")).toBe(true);
		expect(writeBody.includes("markDirty()")).toBe(true);
		expect(writeBody.includes("this.save?.()")).toBe(false);
	});

	it("两个构造点都注入 saveTalosVoiceSession", () => {
		for (const file of ["src/view.ts", "src/ui/pages/workspace-pages.ts"]) {
			expectSourceContains(file, "saveTalosVoiceSession()");
			expectSourceNotContains(file, "saveTalosVoiceSession;\n");
		}
	});
});
