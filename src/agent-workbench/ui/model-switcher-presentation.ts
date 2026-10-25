import type { ModelDescriptor, RuntimeId } from "../contracts/runtime-adapter";

export interface ModelSwitchPresentation {
	label: string;
	kicker: string;
	description: string;
	badge?: string;
}

export function reasoningForModel(model: ModelDescriptor | undefined, current: string | undefined): string | undefined {
	if (!model) return undefined;
	const supported = new Set((model.reasoningOptions ?? []).map((option) => option.value.trim()).filter(Boolean));
	if (current && supported.has(current)) return current;
	const fallback = model.defaultReasoning?.trim();
	if (!fallback) return undefined;
	return supported.size === 0 || supported.has(fallback) ? fallback : undefined;
}

export function explicitDefaultModel(
	runtimeId: RuntimeId,
	models: ModelDescriptor[],
	current: string | undefined,
): string | undefined {
	if (current || runtimeId !== "ohmypi") return current;
	return models[0]?.id;
}

export function presentRuntimeModel(_runtimeId: RuntimeId, model: ModelDescriptor): ModelSwitchPresentation {
	return { label: model.label, kicker: "OhMyPi", description: model.providerProfileId ? `来自 ${model.providerProfileId}` : "由当前运行时提供" };
}

export function automaticModelPresentation(_runtimeId: RuntimeId): ModelSwitchPresentation {
	return {
		label: "自动选择",
		kicker: "终端默认",
		description: "跟随 OhMyPi 当前配置，不覆盖原生默认模型",
	};
}
