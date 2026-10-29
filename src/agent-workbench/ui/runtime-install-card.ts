import type { RuntimeId, RuntimeProbe } from "../contracts/runtime-adapter";

export interface RuntimeInstallCardModel {
	runtimeId: RuntimeId;
	title: string;
	status: RuntimeProbe["status"];
	detail: string;
	installUrl?: string;
	canRetry: boolean;
}

const LABEL: Record<RuntimeId, string> = { ohmypi: "OhMyPi" };

/**
 * `installUrl` 可缺省：`RuntimeDiscoveryService.installUrl` 现在是
 * `string | undefined`（未知 runtime 无安装链接）。该模块无生产消费方，
 * 此改动只到测试调用面。
 */
export function runtimeInstallCard(probe: RuntimeProbe, installUrl?: string): RuntimeInstallCardModel {
	const unavailable = ["not-installed", "incompatible"].includes(probe.status);
	return {
		runtimeId: probe.runtimeId,
		title: `${LABEL[probe.runtimeId]} 运行时`,
		status: probe.status,
		detail: probe.reason ?? (probe.version ? `版本 ${probe.version}` : "等待检测"),
		installUrl: unavailable && installUrl ? installUrl : undefined,
		canRetry: probe.status !== "probing",
	};
}
