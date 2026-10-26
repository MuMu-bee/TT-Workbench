import { mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { AgentRuntimeAdapter, RuntimeId } from "../contracts/runtime-adapter";
import type { ProviderProfile, RuntimeProfile } from "../contracts/provider-profile";
import { isDirectApiProviderProfile } from "../contracts/provider-profile";
import type { PermissionMode } from "../contracts/approval";
import { buildOhMyPiLaunch, OhMyPiRpcAdapter } from "../adapters/ohmypi/ohmypi-rpc-adapter";
import { ProcessSandbox } from "../security/process-sandbox";
import { OhMyPiProcessPort } from "../transports/ohmypi-process-port";
import { spawnOmpRpc } from "../transports/omp-rpc-connection";
import { resolveCertificateEnvironment } from "./certificate-environment";
import { desktopRuntimePath } from "./node-runtime-probe-host";
import { RuntimeDiscoveryService } from "./runtime-discovery-service";
import { LoopbackEgressProxy } from "../security/loopback-egress-proxy";
import { protectedVaultSubpaths } from "../security/vault-protected-subpaths";
import { DirectApiRuntimeAdapter } from "../adapters/api/direct-api-runtime-adapter";

export { resolveCertificateEnvironment } from "./certificate-environment";

export async function cleanupRuntimeStatusFiles(runtimeTemp: string, now = Date.now()): Promise<number> {
	const statusRoot = path.join(runtimeTemp, ".agent-cockpit", "status");
	let entries;
	try {
		entries = await readdir(statusRoot, { withFileTypes: true });
	} catch {
		return 0;
	}
	let removed = 0;
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const file = path.join(statusRoot, entry.name);
		try {
			const value = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
			const expiresAt = typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : Number.NaN;
			if (!Number.isFinite(expiresAt) || expiresAt > now) continue;
			await rm(file, { force: true });
			removed += 1;
		} catch {
			// Unknown or concurrently changing files remain available for recovery.
		}
	}
	return removed;
}

export interface RuntimeFactoryInput {
	vaultRoot: string;
	configDir?: string;
	permissionMode?: PermissionMode;
	runtimeProfile?: RuntimeProfile;
	providerProfile?: ProviderProfile;
	model?: string;
	approve: (toolName: string, input: Record<string, unknown>, metadata?: Record<string, unknown>) => Promise<"allow" | "allow-always" | "deny">;
	answerQuestion?: (input: Record<string, unknown>, metadata: { requestId: string; toolUseId: string; signal?: AbortSignal }) => Promise<Record<string, string | string[]> | null>;
}

export type ProviderSecretResolver = (secretRef: string) => string | null;

/**
 * TT工作台 1.1.0:原生运行时只剩 OhMyPi;其模型密钥由 OhMyPi 自身配置管理,
 * 不经 profile 环境变量注入。Direct API 走 DirectApiRuntimeAdapter,不进本函数。
 */
export function providerEnvironmentForRuntime(
	runtimeId: RuntimeId,
	profile: ProviderProfile | undefined,
	resolveSecret: ProviderSecretResolver
): Record<string, string> {
	if (!profile) return {};
	if (profile.runtimeId !== runtimeId) {
		throw new Error("Provider profile 与运行时不匹配");
	}
	const secret = profile.secretRef
		? resolveSecret(profile.secretRef)
		: null;
	if (profile.secretRef && !secret) {
		throw new Error(`${profile.displayName} 的 SecretStorage 凭据不可用`);
	}
	return {};
}

function runtimeInstallationRoot(executable: string): string {
	const normalized = executable.replace(/\\/g, "/");
	for (const marker of ["/.codex/packages/", "/.bun/", "/.local/"]) {
		const index = normalized.indexOf(marker);
		if (index >= 0) return normalized.slice(0, index + marker.length - 1);
	}
	if (normalized.startsWith("/opt/homebrew/")) return "/opt/homebrew";
	if (normalized.startsWith("/usr/local/")) return "/usr/local";
	return path.dirname(executable);
}

export class DesktopRuntimeFactory {
	constructor(
		private readonly discovery: RuntimeDiscoveryService,
		private readonly sandbox: ProcessSandbox,
		private readonly resolveSecret: ProviderSecretResolver = () => null,
		private readonly fetcher?: typeof fetch,
	) {}

	async probe(runtimeId: RuntimeId, profile?: RuntimeProfile) {
		const probe = await this.discovery.probe(runtimeId, profile);
		if (probe.status !== "ready") return probe;
		const isolation = await this.sandbox.availability();
		if (!isolation.available) {
			return {
				...probe,
				status: "degraded" as const,
				reason: isolation.message,
			};
		}
		if (isolation.backend === "windows-approval-only") {
			// 无 OS 隔离:可执行,但必须持续显示事实,不能省略。
			return {
				...probe,
				sandboxNote: "无操作系统级隔离 · 每条命令经审批并写审计",
			};
		}
		return probe;
	}

	async create(runtimeId: RuntimeId, input: RuntimeFactoryInput): Promise<AgentRuntimeAdapter> {
		if (isDirectApiProviderProfile(input.providerProfile)) {
			if (input.providerProfile!.runtimeId !== runtimeId) {
				throw new Error("Direct API Provider profile 与 runtime 不匹配");
			}
			return new DirectApiRuntimeAdapter({
				profile: input.providerProfile!,
				resolveSecret: this.resolveSecret,
				fetcher: this.fetcher,
			});
		}
		const probe = await this.probe(runtimeId, input.runtimeProfile);
		if (probe.status !== "ready" || !probe.executable) throw new Error(probe.reason ?? `${runtimeId} 运行时不可用`);
		await this.sandbox.assertAvailable();
		const probeRuntime = (signal?: AbortSignal) => this.discovery.probe(runtimeId, input.runtimeProfile);
		const providerEnvironment = providerEnvironmentForRuntime(
			runtimeId,
			input.providerProfile,
			this.resolveSecret
		);
		const home = process.env.HOME ?? "";
		const runtimeExecutable = await realpath(probe.executable);
		const packageRoot = runtimeInstallationRoot(runtimeExecutable);
		const sessionRoot = home ? path.join(home, ".omp") : input.vaultRoot;
		const runtimeTemp = path.join(input.vaultRoot, ".talos", "agent-workbench", "v1", "runtime-tmp", runtimeId);
		await cleanupRuntimeStatusFiles(runtimeTemp);
		await Promise.all([mkdir(runtimeTemp, { recursive: true }), mkdir(sessionRoot, { recursive: true })]);
		const proxy = new LoopbackEgressProxy(async ({ host, port }) => {
			const decision = await input.approve("NetworkRequest", { url: "https://" + host + ":" + port }, { reason: "provider-egress-proxy", host, port });
			return decision;
		});
		const proxyPort = await proxy.start();
		const proxyUrl = "http://localhost:" + proxyPort;
		const certificates = await resolveCertificateEnvironment();
		const certificateRoots = certificates.readRoots;
		const environment = {
			PATH: desktopRuntimePath(probe.executable), HOME: process.env.HOME ?? "", CFFIXED_USER_HOME: runtimeTemp, TMPDIR: runtimeTemp, LANG: process.env.LANG ?? "",
			__CFPREFERENCES_AVOID_DAEMON: "1",
			...certificates.environment,
			HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl,
			http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl, NO_PROXY: "", no_proxy: "",
			...providerEnvironment,
		};
		try {
			const raw = buildOhMyPiLaunch(runtimeExecutable, input.vaultRoot, input.permissionMode ?? "ask", input.model);
			const launch = await this.sandbox.prepare({
				...raw,
				environment,
				readOnlyRoots: [packageRoot, ...certificateRoots],
				readWriteRoots: [sessionRoot, runtimeTemp],
				loopbackProxyPort: proxyPort,
				deniedVaultSubpaths: input.configDir ? protectedVaultSubpaths(input.configDir) : undefined,
				denyDotEnvFiles: true,
			}, input.vaultRoot);
			const connection = spawnOmpRpc(launch);
			try {
				await connection.ready();
				const negotiated = await connection.request<{ protocolVersion: number }>("negotiate_protocol", { protocolVersion: 2 });
				if (negotiated.protocolVersion !== 2) throw new Error("OhMyPi RPC v2 协商失败");
			} catch (error) { await connection.close(); throw error; }
			return new OhMyPiRpcAdapter(new OhMyPiProcessPort(connection, probeRuntime), () => true, () => proxy.close());
		} catch (error) {
			await proxy.close();
			throw error;
		}
	}
}
