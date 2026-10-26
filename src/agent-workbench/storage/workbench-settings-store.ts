import type { PermissionMode, WorkflowMode } from "../contracts/approval";
import type { ProviderProfile, RuntimeProfile } from "../contracts/provider-profile";
import { validateProviderProfile } from "../contracts/provider-profile";
import type { RuntimeId } from "../contracts/runtime-adapter";

export interface RuntimeSelection {
	runtimeId: RuntimeId;
	providerProfileId?: string;
	model?: string;
	reasoning?: string;
	serviceTier?: string;
}

export interface WorkbenchSettings {
	schemaVersion: 1;
	runtimes: RuntimeProfile[];
	providers: ProviderProfile[];
	selection: RuntimeSelection;
	workflow: WorkflowMode;
	permission: PermissionMode;
}

export interface WorkbenchSettingsHost {
	read(): Promise<unknown>;
	write(value: WorkbenchSettings): Promise<void>;
}

export interface SecretReferenceStatus { has(secretRef: string): boolean; }

const SECRET_REF = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SENSITIVE_KEY = /(?:api.?key|token|password|authorization|cookie|secret(?!Ref))/i;
const SENSITIVE_VALUE = /(?:bearer\s+|sk-[a-z0-9_-]{12,}|authorization\s*:)/i;

export function assertSafeWorkbenchSettings(value: unknown, key = ""): void {
	if (SENSITIVE_KEY.test(key)) throw new Error(`设置包含禁止字段：${key}`);
	if (typeof value === "string" && SENSITIVE_VALUE.test(value)) throw new Error("设置包含疑似明文凭据");
	if (Array.isArray(value)) for (const item of value) assertSafeWorkbenchSettings(item, key);
	else if (value && typeof value === "object") for (const [childKey, child] of Object.entries(value)) assertSafeWorkbenchSettings(child, childKey);
}

function defaults(): WorkbenchSettings {
	return { schemaVersion: 1, runtimes: [], providers: [], selection: { runtimeId: "ohmypi" }, workflow: "plan", permission: "ask" };
}

/**
 * TT 1.1.0 收敛为单一原生运行时后,旧数据里仍可能是 claude / codex / hermes 等
 * runtimeId。加载时静默迁移到 ohmypi,而不是抛错——否则老用户升级后整个对话视图
 * 会加载失败(实机验收中发现)。
 */
function migrateRuntimeId(): "ohmypi" {
	return "ohmypi";
}

/** 迁移旧 runtime profile:保留 executablePath/args,只把 runtimeId 归一到 ohmypi。 */
function migrateRuntimeProfile(profile: RuntimeProfile): RuntimeProfile {
	return profile.runtimeId === "ohmypi" ? profile : { ...profile, runtimeId: migrateRuntimeId() };
}

/** 迁移旧 provider profile:把历史 runtimeId 改写到 ohmypi,保留 protocol/endpoint/models。 */
function migrateProviderProfile(profile: ProviderProfile): ProviderProfile {
	return profile.runtimeId === "ohmypi" ? profile : { ...profile, runtimeId: migrateRuntimeId() };
}

function normalizeSelection(selection: RuntimeSelection, providers: ProviderProfile[]): RuntimeSelection {
	// 非法/缺失 selection 不再抛错:回落到默认运行时(用户的 workflow/permission 仍然保留)。
	if (!selection || typeof selection !== "object") return { runtimeId: "ohmypi" };
	if (selection.runtimeId !== "ohmypi") return { runtimeId: "ohmypi" };
	const reasoning = typeof selection.reasoning === "string" && selection.reasoning.trim() ? selection.reasoning.trim() : undefined;
	const serviceTier = typeof selection.serviceTier === "string" && selection.serviceTier.trim() ? selection.serviceTier.trim() : undefined;
	if (!selection.providerProfileId) {
		return {
			runtimeId: selection.runtimeId,
			...(selection.model ? { model: selection.model } : {}),
			...(reasoning ? { reasoning } : {}),
			...(serviceTier ? { serviceTier } : {}),
		};
	}
	const provider = providers.find((candidate) => candidate.enabled && candidate.id === selection.providerProfileId && candidate.runtimeId === selection.runtimeId);
	// profile 已被丢弃或不可用时,清空 provider 与 model,避免界面停留在不存在的 provider 上。
	if (!provider) return { runtimeId: selection.runtimeId };
	return {
		runtimeId: selection.runtimeId,
		providerProfileId: provider.id,
		...(selection.model && provider.models.includes(selection.model) ? { model: selection.model } : {}),
		...(reasoning ? { reasoning } : {}),
		...(serviceTier ? { serviceTier } : {}),
	};
}

export class WorkbenchSettingsStore {
	constructor(private readonly host: WorkbenchSettingsHost, private readonly secrets: SecretReferenceStatus) {}

	async load(): Promise<WorkbenchSettings> {
		const raw = await this.host.read();
		if (!raw) return defaults();
		assertSafeWorkbenchSettings(raw);
		const value = raw as WorkbenchSettings;
		if (value.schemaVersion !== 1 || !Array.isArray(value.runtimes) || !Array.isArray(value.providers)) throw new Error("工作台设置 schema 无效");
		// 旧版可能带有本版不再支持的协议(如自定义 hermes-agent):丢弃那一条,
		// 保留其余可用 profile。不能让单条历史配置导致整个对话视图加载失败。
		const providers = value.providers
			.map((profile) => migrateProviderProfile(profile))
			.flatMap((profile) => {
				try {
					return [validateProviderProfile(profile)];
				} catch {
					return [];
				}
			});
		for (const profile of providers) {
			if (profile.secretRef && !SECRET_REF.test(profile.secretRef)) throw new Error("secretRef 无效");
		}
		const runtimes = value.runtimes.map((profile) => migrateRuntimeProfile(profile));
		return { ...value, runtimes, providers, selection: normalizeSelection(value.selection, providers) };
	}

	async save(settings: WorkbenchSettings): Promise<void> {
		assertSafeWorkbenchSettings(settings);
		const providers = settings.providers.map((profile) => validateProviderProfile(profile));
		for (const profile of providers) if (profile.secretRef && !SECRET_REF.test(profile.secretRef)) throw new Error("secretRef 无效");
		await this.host.write({ ...settings, providers, selection: normalizeSelection(settings.selection, providers) });
	}

	authenticationStatus(profile: ProviderProfile): "not-required" | "configured" | "missing" {
		if (!profile.secretRef) return "not-required";
		return this.secrets.has(profile.secretRef) ? "configured" : "missing";
	}
}
