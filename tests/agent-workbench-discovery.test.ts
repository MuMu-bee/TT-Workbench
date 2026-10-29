import { describe, expect, it } from "vitest";
import type { RuntimeId } from "../src/agent-workbench/contracts/runtime-adapter";
import { RuntimeDiscoveryService, type ProtocolHandshake, type RuntimeProbeHost } from "../src/agent-workbench/discovery/runtime-discovery-service";
import { DesktopRuntimeFactory } from "../src/agent-workbench/discovery/desktop-runtime-factory";
import { ProcessSandbox } from "../src/agent-workbench/security/process-sandbox";
import { PortableConversationStore, type PortableFileAdapter } from "../src/agent-workbench/storage/portable-conversation-store";
import { runtimeInstallCard } from "../src/agent-workbench/ui/runtime-install-card";

class FakeProbeHost implements RuntimeProbeHost {
	executable: string | null = "/synthetic/bin/agent";
	version = "agent 1.2.3";
	exitCode = 0;
	handshakeResult: ProtocolHandshake = "ready";
	crash: Error | null = null;
	resolvedCandidates: string[] = [];
	async resolve(candidates: string[]) { this.resolvedCandidates = candidates; return this.executable; }
	async run() { if (this.crash) throw this.crash; return { exitCode: this.exitCode, stdout: this.version, stderr: "" }; }
	async handshake(_runtimeId: RuntimeId) { if (this.crash) throw this.crash; return this.handshakeResult; }
}

/** 只够 `PortableConversationStore.load` 用的只读适配器：manifest 一份、events 为空。 */
function manifestOnlyFiles(manifest: Record<string, unknown>): PortableFileAdapter {
	const MANIFEST = ".talos/agent-workbench/v1/conversations/conversation-legacy/manifest.json";
	return {
		exists: async (path) => path === MANIFEST,
		read: async (path) => {
			if (path !== MANIFEST) throw new Error(`missing: ${path}`);
			return JSON.stringify(manifest);
		},
		list: async () => ({ files: [], folders: [] }),
		write: async () => { throw new Error("只读适配器不支持写入"); },
		rename: async () => { throw new Error("只读适配器不支持写入"); },
		replace: async () => { throw new Error("只读适配器不支持写入"); },
		remove: async () => { throw new Error("只读适配器不支持写入"); },
		mkdir: async () => { throw new Error("只读适配器不支持写入"); },
	};
}

describe("RuntimeDiscoveryService", () => {
	it("covers ready, missing, incompatible, unauthenticated, degraded and crashed states", async () => {
		const host = new FakeProbeHost();
		const service = new RuntimeDiscoveryService(host);
		expect((await service.probe("ohmypi")).status).toBe("ready");
		host.executable = null;
		expect((await service.probe("ohmypi")).status).toBe("not-installed");
		host.executable = "/synthetic/bin/omp"; host.version = "omp 0.0.9";
		expect((await service.probe("ohmypi")).status).toBe("incompatible");
		host.version = "omp 0.32.1"; host.handshakeResult = "unauthenticated";
		expect((await service.probe("ohmypi")).status).toBe("unauthenticated");
		host.handshakeResult = "degraded";
		expect((await service.probe("ohmypi")).status).toBe("degraded");
		host.crash = new Error("synthetic crash");
		expect((await service.probe("ohmypi")).status).toBe("crashed");
	});

	it("prioritizes an explicit executable and produces bounded install guidance", async () => {
		const host = new FakeProbeHost();
		const service = new RuntimeDiscoveryService(host);
		host.version = "omp/17.2.15";
		expect(await service.probe("ohmypi")).toMatchObject({ status: "ready", version: "17.2.15" });
		host.version = "agent 1.2.3";
		await service.probe("ohmypi", { id: "omp-local", runtimeId: "ohmypi", executablePath: "/custom/omp" });
		expect(host.resolvedCandidates[0]).toBe("/custom/omp");
		host.executable = null;
		const probe = await service.probe("ohmypi");
		const card = runtimeInstallCard(probe, service.installUrl("ohmypi"));
		expect(card.installUrl).toMatch(/^https:/);
		expect(card.canRetry).toBe(true);
	});

	// Q-QUA10：`SPECIFICATIONS[runtimeId]` 无 undefined 守卫，与
	// contracts/runtime-adapter.ts:5-7「读取层按未知 runtime 降级」的承诺不符。
	it("degrades an unknown runtime id to a readable health instead of throwing", async () => {
		const host = new FakeProbeHost();
		const service = new RuntimeDiscoveryService(host);
		const unknown = "codex" as unknown as RuntimeId;
		await expect(service.probe(unknown)).resolves.toMatchObject({ status: "degraded" });
		expect((await service.probe(unknown)).reason).toContain("未知运行时");
		// installUrl 是同步方法：不抛错即返回 undefined（未知 runtime 不出安装链接）。
		expect(service.installUrl(unknown)).toBeUndefined();
		// 未知 runtime 不得把 undefined.command 拼进候选。
		expect(host.resolvedCandidates).toEqual([]);
	});

	// 可达性用例：钉在「一发消息」真正走的那条链（factory.create → probe），
	// 只证到「manifest 读取不归一 + factory 会走到 SPECIFICATIONS」，
	// 真实磁盘上是否存在旧 manifest 仍未复核。
	it("reaches a readable error through the runtime factory and keeps non-ohmypi ids in memory", async () => {
		const discovery = new RuntimeDiscoveryService(new FakeProbeHost());
		const factory = new DesktopRuntimeFactory(discovery, new ProcessSandbox({ available: async () => true }, "darwin"));
		const failure = await factory.create("codex" as unknown as RuntimeId, {
			vaultRoot: "/synthetic/vault",
			approve: async () => "deny",
		}).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		expect(failure).not.toBeInstanceOf(TypeError);
		expect((failure as Error).message).toContain("未知运行时");

		const store = new PortableConversationStore(manifestOnlyFiles({
			schemaVersion: 1,
			conversationId: "conversation-legacy",
			title: "旧会话",
			createdAt: "2026-08-01T00:00:00.000Z",
			updatedAt: "2026-08-01T00:00:00.000Z",
			lifecycle: "active",
			selection: { runtimeId: "codex" },
		}));
		const projection = await store.load("conversation-legacy");
		expect(projection.manifest.selection.runtimeId).toBe("codex");
	});
});
