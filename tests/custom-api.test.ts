import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { parseEnvBlock, parseModelList, validateCustomApi } from "../src/agent-workbench/config/custom-api";

vi.mock("obsidian", () => ({ Modal: class {}, Notice: class {} }));

const { saveCustomApi } = await import("../src/plugin/custom-api-modal");

function secretStore() {
	const secrets = new Map<string, string>();
	return {
		secrets,
		port: {
			setSecret: (id: string, value: string) => void secrets.set(id, value),
			getSecret: (id: string) => secrets.get(id) ?? null,
			listSecrets: () => [...secrets.keys()],
		},
	};
}

describe("custom API env parsing", () => {
	it("splits a Claudian Anthropic env block and tolerates padding, quotes and export", () => {
		const parsed = parseEnvBlock([
			"ANTHROPIC_API_KEY=placeholder-key            ",
			"export ANTHROPIC_BASE_URL=\"https://open.bigmodel.cn/api/anthropic\"",
			"ANTHROPIC_MODEL=glm-5.3",
			"# 注释行",
			"CODEX_SANDBOX=workspace-write",
		].join("\n"));
		expect(parsed).toEqual({
			kind: "anthropic",
			apiKey: "placeholder-key",
			baseUrl: "https://open.bigmodel.cn/api/anthropic",
			models: ["glm-5.3"],
		});
	});

	it("recognises OpenAI blocks and ignores the other vendor's lines", () => {
		const parsed = parseEnvBlock("OPENAI_BASE_URL=https://api.openai.com/v1\nOPENAI_MODEL=gpt-5.5\nANTHROPIC_MODEL=glm-5.3");
		expect(parsed).toEqual({ kind: "openai", baseUrl: "https://api.openai.com/v1", models: ["gpt-5.5"] });
		expect(parseEnvBlock("NODE_OPTIONS=--inspect")).toEqual({});
	});

	it("parses comma or newline separated model lists without duplicates", () => {
		expect(parseModelList("glm-5.3, glm-5.2，glm-5.3\nglm-4.6")).toEqual(["glm-5.3", "glm-5.2", "glm-4.6"]);
	});
});

describe("custom API validation", () => {
	const draft = { kind: "anthropic" as const, baseUrl: "https://open.bigmodel.cn/api/anthropic", models: ["glm-5.3"], apiKey: "k" };

	it("accepts HTTPS and loopback HTTP endpoints", () => {
		expect(validateCustomApi(draft, false)).toBeNull();
		expect(validateCustomApi({ ...draft, baseUrl: "http://127.0.0.1:8080" }, false)).toBeNull();
		expect(validateCustomApi({ ...draft, baseUrl: "" }, false)).toBeNull();
	});

	it("rejects plain HTTP, embedded credentials, missing models and missing keys", () => {
		expect(validateCustomApi({ ...draft, baseUrl: "http://example.com" }, false)).toContain("HTTPS");
		expect(validateCustomApi({ ...draft, baseUrl: "https://user:pw@example.com" }, false)).toContain("账号");
		expect(validateCustomApi({ ...draft, models: [] }, false)).toContain("模型");
		expect(validateCustomApi({ ...draft, apiKey: "" }, false)).toContain("API Key");
		expect(validateCustomApi({ ...draft, apiKey: "" }, true)).toBeNull();
	});
});

describe("saving a custom API", () => {
	function port() {
		const store = secretStore();
		const talosSettings = {
			anthropicBaseUrl: "", agentWorkbenchClaudeModels: "", anthropicApiKey: "",
			codexBaseUrl: "", agentWorkbenchCodexModels: "", codexApiKey: "",
			providerSecretRefs: {},
		};
		const save = vi.fn(async () => undefined);
		return { store, save, value: { app: { secretStorage: store.port }, talosSettings, saveTalosSettings: save } };
	}

	it("stores the key in SecretStorage, never in settings, and targets the Claude Agent API profile", async () => {
		const { store, save, value } = port();
		const result = await saveCustomApi(value as never, {
			kind: "anthropic", baseUrl: " https://open.bigmodel.cn/api/anthropic ", models: ["glm-5.3", "glm-5.2"], apiKey: "placeholder-key",
		});
		expect(result).toEqual({ runtimeId: "claude", profileId: "anthropic", model: "glm-5.3" });
		expect(value.talosSettings.anthropicBaseUrl).toBe("https://open.bigmodel.cn/api/anthropic");
		expect(value.talosSettings.agentWorkbenchClaudeModels).toBe("glm-5.3\nglm-5.2");
		expect(value.talosSettings.anthropicApiKey).toBe("");
		expect(JSON.stringify(value.talosSettings)).not.toContain("placeholder-key");
		expect([...store.secrets.values()]).toEqual(["placeholder-key"]);
		expect(save).toHaveBeenCalledOnce();
	});

	it("keeps the saved key when the field is left empty and refuses invalid drafts", async () => {
		const { store, value } = port();
		await saveCustomApi(value as never, { kind: "openai", baseUrl: "", models: ["gpt-5.5"], apiKey: "first" });
		const result = await saveCustomApi(value as never, { kind: "openai", baseUrl: "https://api.openai.com/v1", models: ["gpt-5.5"], apiKey: "" });
		expect(result.runtimeId).toBe("codex");
		expect([...store.secrets.values()]).toEqual(["first"]);
		await expect(saveCustomApi(value as never, { kind: "openai", baseUrl: "http://example.com", models: ["x"], apiKey: "" })).rejects.toThrow("HTTPS");
	});

	it("puts the entry at the top of the model menu and switches runtime, profile and model after saving", () => {
		const workbench = readFileSync(new URL("../src/agent-workbench/ui/talos-agent-workbench.ts", import.meta.url), "utf8");
		expect(workbench).toContain('customApiLabel.textContent = "自定义 API"');
		expect(workbench).toContain("menuRuntime.appendChild(customApi);");
		expect(workbench).toContain("this.options.service.selectProviderProfile(result.profileId);");
		expect(workbench).toContain("this.options.service.selectModel(result.model);");
	});
});
