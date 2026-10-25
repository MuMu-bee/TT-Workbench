// 对话侧栏「自定义 API」配置窗口：填写或粘贴环境变量 → 校验 → 写入设置与 SecretStorage
// → 同步工作台 Provider profile。密钥只经 SecretStorage 保存，窗口不回显已存密钥。
import { Modal, Notice, type App } from "obsidian";
import {
	CUSTOM_API_TARGETS,
	parseEnvBlock,
	parseModelList,
	validateCustomApi,
	type CustomApiDraft,
	type CustomApiHost,
	type CustomApiKind,
	type CustomApiResult,
} from "../agent-workbench/config/custom-api";
import { providerSecretStoreFromApp, saveProviderSecret } from "../ai/provider/secret-storage-runtime";
import type { TalosSettings } from "../settings";

export interface CustomApiSettingsPort {
	app: App;
	talosSettings: TalosSettings;
	saveTalosSettings(): Promise<void>;
}

const SETTINGS_FIELDS = {
	anthropic: { baseUrl: "anthropicBaseUrl", models: "agentWorkbenchClaudeModels", secret: "anthropicApiKey" },
	openai: { baseUrl: "openaiBaseUrl", models: "agentWorkbenchCodexModels", secret: "openaiApiKey" },
} as const;

function hasSavedKey(port: CustomApiSettingsPort, kind: CustomApiKind): boolean {
	const reference = port.talosSettings.providerSecretRefs[SETTINGS_FIELDS[kind].secret];
	return Boolean(reference && providerSecretStoreFromApp(port.app)?.has(reference));
}

function savedDraft(port: CustomApiSettingsPort, kind: CustomApiKind): CustomApiDraft {
	const fields = SETTINGS_FIELDS[kind];
	return {
		kind,
		baseUrl: port.talosSettings[fields.baseUrl],
		models: parseModelList(port.talosSettings[fields.models]),
		apiKey: "",
	};
}

export interface CustomApiSummary {
	configured: boolean;
	baseUrl: string;
	models: string[];
}

/** 设置页摘要：是否已保存密钥、端点与模型（不读取密钥内容）。 */
export function customApiSummary(port: CustomApiSettingsPort, kind: CustomApiKind): CustomApiSummary {
	const draft = savedDraft(port, kind);
	return { configured: hasSavedKey(port, kind), baseUrl: draft.baseUrl, models: draft.models };
}

/** 写入设置与密钥并同步 profile；返回工作台要切换到的目标。 */
export async function saveCustomApi(port: CustomApiSettingsPort, draft: CustomApiDraft): Promise<CustomApiResult> {
	const error = validateCustomApi(draft, hasSavedKey(port, draft.kind));
	if (error) throw new Error(error);
	const fields = SETTINGS_FIELDS[draft.kind];
	if (draft.apiKey.trim()) {
		saveProviderSecret(port.talosSettings, fields.secret, draft.apiKey, providerSecretStoreFromApp(port.app));
	}
	port.talosSettings[fields.baseUrl] = draft.baseUrl.trim();
	port.talosSettings[fields.models] = draft.models.join("\n");
	await port.saveTalosSettings();
	const target = CUSTOM_API_TARGETS[draft.kind];
	return { runtimeId: target.runtimeId, profileId: target.profileId, model: draft.models[0] };
}

class CustomApiModal extends Modal {
	private result: CustomApiResult | null = null;
	private body!: HTMLElement;

	constructor(
		private readonly port: CustomApiSettingsPort,
		private readonly done: (result: CustomApiResult | null) => void,
		private kind: CustomApiKind = "anthropic",
	) {
		super(port.app);
	}

	onOpen(): void {
		this.setTitle("自定义 API");
		this.modalEl.addClass("talos-custom-api-modal");
		this.body = this.contentEl.createDiv({ cls: "talos-custom-api" });
		this.render(savedDraft(this.port, this.kind));
	}

	private render(draft: CustomApiDraft): void {
		this.kind = draft.kind;
		const target = CUSTOM_API_TARGETS[draft.kind];
		const keySaved = hasSavedKey(this.port, draft.kind);
		this.body.empty();

		const kinds = this.body.createDiv({ cls: "talos-custom-api__kinds", attr: { role: "radiogroup", "aria-label": "API 类型" } });
		for (const option of Object.values(CUSTOM_API_TARGETS)) {
			const button = kinds.createEl("button", {
				text: option.label,
				cls: option.kind === draft.kind ? "is-active" : "",
				attr: { type: "button", role: "radio", "aria-checked": String(option.kind === draft.kind) },
			});
			button.addEventListener("click", () => {
				if (option.kind !== this.kind) this.render(savedDraft(this.port, option.kind));
			});
		}
		this.body.createEl("p", { cls: "talos-custom-api__hint", text: target.description });

		const env = this.body.createEl("textarea", {
			cls: "talos-custom-api__env",
			attr: { rows: "4", spellcheck: "false", "aria-label": "粘贴环境变量", placeholder: "可粘贴 Claudian 的环境变量，自动填入下面各项：\nANTHROPIC_BASE_URL=…\nANTHROPIC_API_KEY=…\nANTHROPIC_MODEL=…" },
		});

		const baseUrl = this.field("Base URL", "留空使用官方端点").createEl("input", {
			attr: { type: "url", spellcheck: "false", placeholder: target.baseUrlPlaceholder },
		});
		baseUrl.value = draft.baseUrl;
		const models = this.field("模型", "多个用逗号分隔，第一个为默认").createEl("input", {
			attr: { type: "text", spellcheck: "false", placeholder: target.modelPlaceholder },
		});
		models.value = draft.models.join(", ");
		const apiKey = this.field("API Key", keySaved ? "已安全保存；留空则沿用" : "保存到 Obsidian SecretStorage，不写入 data.json").createEl("input", {
			attr: { type: "password", autocomplete: "off", spellcheck: "false", placeholder: keySaved ? "已保存（留空不修改）" : "粘贴密钥" },
		});
		apiKey.value = draft.apiKey;

		const error = this.body.createDiv({ cls: "talos-custom-api__error", attr: { role: "alert" } });
		const collect = (): CustomApiDraft => ({
			kind: this.kind,
			baseUrl: baseUrl.value,
			models: parseModelList(models.value),
			apiKey: apiKey.value,
		});

		// 粘贴或离开输入框时识别，避免逐字输入时反复重绘
		const applyEnv = () => {
			const parsed = parseEnvBlock(env.value);
			if (!parsed.kind) return;
			const next = collect();
			// 识别出的类型与当前不同时切换类型，再把识别到的字段填进去
			this.render({
				kind: parsed.kind,
				baseUrl: parsed.baseUrl ?? (parsed.kind === next.kind ? next.baseUrl : ""),
				models: parsed.models ?? (parsed.kind === next.kind ? next.models : []),
				apiKey: parsed.apiKey ?? (parsed.kind === next.kind ? next.apiKey : ""),
			});
			new Notice("已从环境变量填入");
		};
		env.addEventListener("paste", () => window.setTimeout(applyEnv, 0));
		env.addEventListener("change", applyEnv);

		const actions = this.body.createDiv({ cls: "talos-custom-api__actions" });
		actions.createEl("button", { text: "取消", attr: { type: "button" } }).addEventListener("click", () => this.close());
		const save = actions.createEl("button", { text: "保存并切换", cls: "mod-cta", attr: { type: "button" } });
		save.addEventListener("click", () => {
			const draftToSave = collect();
			const problem = validateCustomApi(draftToSave, hasSavedKey(this.port, draftToSave.kind));
			error.setText(problem ?? "");
			if (problem) return;
			save.disabled = true;
			void saveCustomApi(this.port, draftToSave).then((result) => {
				this.result = result;
				new Notice(`已保存${CUSTOM_API_TARGETS[draftToSave.kind].label} API`);
				this.close();
			}).catch((reason: unknown) => {
				error.setText(reason instanceof Error ? reason.message : String(reason));
				save.disabled = false;
			});
		});
	}

	private field(label: string, hint: string): HTMLElement {
		const row = this.body.createEl("label", { cls: "talos-custom-api__field" });
		const head = row.createDiv({ cls: "talos-custom-api__label" });
		head.createSpan({ text: label });
		head.createEl("small", { text: hint });
		return row;
	}

	onClose(): void {
		this.contentEl.empty();
		this.done(this.result);
	}
}

export function createCustomApiHost(port: CustomApiSettingsPort): CustomApiHost {
	return {
		open: (kind) => new Promise((resolve) => new CustomApiModal(port, resolve, kind).open()),
	};
}
