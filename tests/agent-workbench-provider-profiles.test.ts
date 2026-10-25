import { describe, expect, it } from "vitest";
import {
	buildTalosProviderProfiles,
	parseModelCatalog,
	preferredDirectApiProfile,
} from "../src/agent-workbench/config/talos-provider-profiles";
import {
	providerEnvironmentForRuntime,
} from "../src/agent-workbench/discovery/desktop-runtime-factory";
import type { ProviderProfile } from "../src/agent-workbench/contracts/provider-profile";
import { RuntimeBindingStore } from "../src/agent-workbench/storage/runtime-binding-store";

const settings = {
	anthropicBaseUrl: "https://anthropic.example.test",
	openaiBaseUrl: "https://chat.example.test/v1",
	codexBaseUrl: "https://responses.example.test/v1",
	jarvisModel: "claude-legacy",
	openaiModel: "chat-legacy",
	codexModel: "codex-legacy",
	agentWorkbenchClaudeModels: "claude-a\nclaude-b\nclaude-a",
	agentWorkbenchCodexModels: "codex-a, codex-b",
	providerSecretRefs: {
		anthropicApiKey: "talos-anthropic-api-key",
		openaiApiKey: "talos-openai-api-key",
		codexApiKey: "talos-codex-api-key",
	},
};

describe("TT provider profile projection", () => {
	it("publishes only the Anthropic Messages direct profile backed by SecretStorage", () => {
		const onlyAnthropic = buildTalosProviderProfiles(
			settings,
			(reference) => reference === "talos-anthropic-api-key"
		);
		expect(onlyAnthropic).toEqual([
			expect.objectContaining({
				id: "anthropic-api",
				runtimeId: "ohmypi",
				protocol: "anthropic-messages",
				secretRef: "talos-anthropic-api-key",
				models: ["claude-a", "claude-b", "claude-legacy"],
			}),
		]);
		expect(JSON.stringify(onlyAnthropic)).not.toContain("synthetic-secret-value");
	});

	it("projects OpenAI Chat as an explicit direct profile", () => {
		const profiles = buildTalosProviderProfiles(
			settings,
			(reference) => reference === "talos-openai-api-key",
		);
		expect(profiles).toEqual([
			expect.objectContaining({
				id: "openai-compatible",
				runtimeId: "ohmypi",
				protocol: "openai-chat",
				endpoint: "https://chat.example.test/v1",
				models: ["codex-a", "codex-b", "chat-legacy"],
			}),
		]);
	});

	it("never emits a profile for legacy codex-only credentials", () => {
		expect(
			buildTalosProviderProfiles(settings, (reference) => reference === "talos-codex-api-key")
		).toEqual([]);
	});

	it("prefers the console-selected direct profile and falls back deterministically", () => {
		const profiles = buildTalosProviderProfiles(settings, () => true);
		expect(preferredDirectApiProfile(profiles, "claude-api")?.id).toBe("anthropic-api");
		expect(preferredDirectApiProfile(profiles, "codex-cli")?.id).toBe("openai-compatible");
		expect(preferredDirectApiProfile(
			profiles.filter((profile) => profile.id !== "openai-compatible"),
			"codex-cli",
		)?.id).toBe("anthropic-api");
	});

	it("deduplicates newline and comma model catalogs while retaining a legacy model", () => {
		expect(parseModelCatalog("model-a\nmodel-b, model-a", "model-c")).toEqual([
			"model-a",
			"model-b",
			"model-c",
		]);
	});
});

describe("provider runtime environment", () => {
	it("returns an empty environment for OhMyPi (keys live in OhMyPi's own config)", () => {
		const profile: ProviderProfile = {
			id: "anthropic-api",
			displayName: "Anthropic Messages · Direct API",
			runtimeId: "ohmypi",
			protocol: "anthropic-messages",
			endpoint: "https://anthropic.example.test",
			models: ["claude-a"],
			secretRef: "talos-anthropic-api-key",
			enabled: true,
		};
		let reads = 0;
		expect(
			providerEnvironmentForRuntime("ohmypi", profile, () => {
				reads += 1;
				return "synthetic-secret-value";
			})
		).toEqual({});
		expect(
			providerEnvironmentForRuntime("ohmypi", undefined, () => {
				reads += 1;
				return null;
			})
		).toEqual({});
		expect(reads).toBe(1);
	});

	it("fails closed for a missing API secret and rejects runtime mismatch", () => {
		const profile: ProviderProfile = {
			id: "anthropic-api",
			displayName: "Anthropic Messages · Direct API",
			runtimeId: "ohmypi",
			protocol: "anthropic-messages",
			models: ["claude-a"],
			secretRef: "talos-anthropic-api-key",
			enabled: true,
		};
		expect(() =>
			providerEnvironmentForRuntime("ohmypi", profile, () => null)
		).toThrow("SecretStorage");
	});
});

describe("provider-scoped native bindings", () => {
	it("keeps native and API sessions separate while retaining legacy native fallback", async () => {
		let state: Record<string, unknown> | null = {
			bindings: {
				"legacy:ohmypi": {
					runtimeId: "ohmypi",
					sessionId: "legacy-native",
				},
			},
		};
		const store = new RuntimeBindingStore({
			read: async () => structuredClone(state),
			write: async (value) => {
				state = structuredClone(value);
			},
		});
		await store.set("conversation", {
			runtimeId: "ohmypi",
			sessionId: "native-session",
		});
		await store.set("conversation", {
			runtimeId: "ohmypi",
			sessionId: "api-session",
			providerProfileId: "openai-compatible",
		});
		expect(await store.get("conversation", "ohmypi")).toMatchObject({
			sessionId: "native-session",
		});
		expect(await store.get("conversation", "ohmypi", "openai-compatible")).toMatchObject({
			sessionId: "api-session",
			providerProfileId: "openai-compatible",
		});
		expect(await store.get("legacy", "ohmypi")).toMatchObject({
			sessionId: "legacy-native",
		});
		expect(await store.get("legacy", "ohmypi", "openai-compatible")).toBeNull();
	});
});
