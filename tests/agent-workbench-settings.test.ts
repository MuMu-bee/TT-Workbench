import { describe, expect, it } from "vitest";
import type { WorkbenchSettings } from "../src/agent-workbench/storage/workbench-settings-store";
import { WorkbenchSettingsStore } from "../src/agent-workbench/storage/workbench-settings-store";
import { AgentWorkbenchService } from "../src/agent-workbench/core/agent-workbench-service";

function settings(): WorkbenchSettings {
	return {
		schemaVersion: 1,
		runtimes: [{ id: "codex-local", runtimeId: "ohmypi", executablePath: "/synthetic/codex" }],
		providers: [{
			id: "openai-main", displayName: "OpenAI", runtimeId: "ohmypi", protocol: "openai-responses",
			endpoint: "https://api.example.test/", models: ["model-a"], secretRef: "talos-openai-main", enabled: true,
		}],
		selection: { runtimeId: "ohmypi", providerProfileId: "openai-main", model: "model-a", reasoning: "high", serviceTier: "fast" },
		workflow: "plan", permission: "ask",
	};
}

describe("WorkbenchSettingsStore", () => {
	it("stores only provider secret references and normalizes the displayed endpoint", async () => {
		const persisted: WorkbenchSettings[] = [];
		let secretReads = 0;
		const store = new WorkbenchSettingsStore(
			{ read: async () => persisted.at(-1) ?? null, write: async (value) => { persisted.push(structuredClone(value)); } },
			{ has: (reference) => { secretReads += 1; return reference === "talos-openai-main"; } },
		);
		await store.save(settings());
		const saved = persisted.at(0);
		expect(saved?.providers.at(0)?.endpoint).toBe("https://api.example.test");
		expect(JSON.stringify(saved)).not.toMatch(/sk-|bearer|apiKey|password/i);
		const provider = saved?.providers.at(0);
		if (!provider) throw new Error("expected saved provider");
		expect(store.authenticationStatus(provider)).toBe("configured");
		expect(secretReads).toBe(1);
	});

	it("rejects protocol mismatch, invalid secret refs and plaintext secret fields", async () => {
		const store = new WorkbenchSettingsStore({ read: async () => null, write: async () => {} }, { has: () => false });
		const wrongProtocol = settings();
		const wrongProtocolProvider = wrongProtocol.providers.at(0);
		if (!wrongProtocolProvider) throw new Error("expected provider fixture");
		wrongProtocolProvider.runtimeId = "claude" as never;
		await expect(store.save(wrongProtocol)).rejects.toThrow("OhMyPi");
		const wrongRef = settings();
		const wrongRefProvider = wrongRef.providers.at(0);
		if (!wrongRefProvider) throw new Error("expected provider fixture");
		wrongRefProvider.secretRef = "not valid";
		await expect(store.save(wrongRef)).rejects.toThrow("secretRef");
		const plaintext = { ...settings(), apiKey: "sk-synthetic-not-a-real-secret" } as unknown as WorkbenchSettings;
		await expect(store.save(plaintext)).rejects.toThrow("禁止字段");
	});

	it("restores provider/runtime/model selection and clears incompatible fields on runtime switch", async () => {
		let value = settings();
		const store = new WorkbenchSettingsStore(
			{ read: async () => structuredClone(value), write: async (next) => { value = structuredClone(next); } },
			{ has: () => true },
		);
		const service = new AgentWorkbenchService({ settingsStore: store });
		await service.initialize();
		expect(service.getSelectedRuntimeId()).toBe("ohmypi");
		expect(service.getSelection()).toEqual({ runtimeId: "ohmypi", providerProfileId: "openai-main", model: "model-a", reasoning: "high", serviceTier: "fast" });
		expect(service.getRuntimeProfile("ohmypi")?.executablePath).toBe("/synthetic/codex");
		expect(await service.listModels("ohmypi")).toEqual([{ id: "model-a", label: "model-a", providerProfileId: "openai-main" }]);
		// TT 1.1.0:单运行时下 selectRuntime 同值不破坏既有选择(旧多运行时切换会清空 profile/model)。
		service.selectRuntime("ohmypi");
		service.setWorkflowMode("execute");
		service.setPermissionMode("scoped");
		await service.flushSettings();
		expect(value).toMatchObject({ selection: { runtimeId: "ohmypi" }, workflow: "execute", permission: "scoped" });
		expect(value.selection).toEqual({ runtimeId: "ohmypi", providerProfileId: "openai-main", model: "model-a", reasoning: "high", serviceTier: "fast" });
		expect(value.providers[0]?.secretRef).toBe("talos-openai-main");
	});

	it("projects the native runtime model into the TALOS selector atomically", async () => {
		let value = settings();
		value.selection = { runtimeId: "ohmypi" };
		const store = new WorkbenchSettingsStore(
			{ read: async () => structuredClone(value), write: async (next) => { value = structuredClone(next); } },
			{ has: () => true },
		);
		const service = new AgentWorkbenchService({
			settingsStore: store,
		});
		await service.initialize();
		service.selectRuntime("ohmypi", "gpt-5.5");
		await service.flushSettings();
		expect(service.getSelection()).toEqual({ runtimeId: "ohmypi", model: "gpt-5.5" });
		expect(value.selection.model).toBe("gpt-5.5");
		service.selectRuntime("ohmypi", null);
		await service.flushSettings();
		expect(service.getSelection()).toEqual({ runtimeId: "ohmypi" });
	});

	it("drops a conversation selection whose provider profile no longer exists", async () => {
		const value = settings();
		const store = new WorkbenchSettingsStore(
			{ read: async () => structuredClone(value), write: async () => undefined },
			{ has: () => true },
		);
		const service = new AgentWorkbenchService({ settingsStore: store });
		await service.initialize();
		service.restoreSelection({
			runtimeId: "ohmypi",
			providerProfileId: "removed-provider",
			model: "removed-model",
			reasoning: "high",
			serviceTier: "fast",
		});
		expect(service.getSelection()).toEqual({ runtimeId: "ohmypi" });
	});

	it("syncs only TALOS-managed API profiles and avoids no-op writes", async () => {
		let value = settings();
		let writes = 0;
		const store = new WorkbenchSettingsStore(
			{
				read: async () => structuredClone(value),
				write: async (next) => {
					writes += 1;
					value = structuredClone(next);
				},
			},
			{ has: () => true },
		);
		const service = new AgentWorkbenchService({
			settingsStore: store,
		});
		await service.initialize();
		const managed = {
			id: "openai",
			displayName: "OpenAI Responses API",
			runtimeId: "ohmypi" as const,
			protocol: "openai-responses" as const,
			endpoint: "https://responses.example.test/",
			models: ["model-b"],
			secretRef: "talos-codex-api-key",
			enabled: true,
		};
		await service.syncProviderProfiles([managed], ["anthropic", "openai"]);
		expect(value.providers.map((profile) => profile.id)).toEqual([
			"openai-main",
			"openai",
		]);
		expect(value.selection.providerProfileId).toBe("openai-main");
		const firstWriteCount = writes;
		await service.syncProviderProfiles([managed], ["anthropic", "openai"]);
		expect(writes).toBe(firstWriteCount);
		await service.syncProviderProfiles([], ["anthropic", "openai"]);
		expect(value.providers.map((profile) => profile.id)).toEqual([
			"openai-main",
		]);
	});
});

it("allows egress only to the selected provider profile", async () => {
	let value = settings();
	value.providers.push({
		id: "openai-unused", displayName: "Unused", runtimeId: "ohmypi", protocol: "openai-responses",
		endpoint: "https://unused.example.test", models: ["model-unused"], enabled: true,
	});
	let providerEgressHosts: string[] = [];
	const store = new WorkbenchSettingsStore(
		{ read: async () => structuredClone(value), write: async (next) => { value = structuredClone(next); } },
		{ has: () => true },
	);
	const approvalBroker = {
		evaluate: async (_request: unknown, context: { providerEgressHosts?: string[] }) => {
			providerEgressHosts = context.providerEgressHosts ?? [];
			return { decision: "allow" };
		},
		rememberExactRule: async () => undefined,
	} as never;
	const service = new AgentWorkbenchService({
		settingsStore: store,
		approvalBroker,
	});
	await service.initialize();
	service.setWorkflowMode("execute");
	await service.authorizeTool({
		runtimeId: "ohmypi", conversationId: "conversation-1", vaultRoot: "/synthetic/vault",
		toolName: "NetworkRequest", toolInput: { url: "https://api.example.test/v1" },
		approvalUiAttached: true,
		prompt: async () => "deny",
	});
	expect(providerEgressHosts).toEqual(["api.example.test"]);
	// TT 1.1.0:同值 selectRuntime 保留 profile;显式清空后再验证出口默认白名单。
	service.restoreSelection({ runtimeId: "ohmypi" });
	await service.authorizeTool({
		runtimeId: "ohmypi", conversationId: "conversation-1", vaultRoot: "/synthetic/vault",
		toolName: "NetworkRequest", toolInput: { url: "https://api.deepseek.com/v1" },
		approvalUiAttached: true,
		prompt: async () => "deny",
	});
	expect(providerEgressHosts).toEqual(["api.deepseek.com", "open.bigmodel.cn"]);
});
