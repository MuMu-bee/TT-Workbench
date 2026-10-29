/**
 * D-TLP-014：DeepSeek Harness 进程管理（Obsidian 桌面端 Node 能力）。
 * 只信任带产品、版本、实例 nonce 与工作区身份的专用 loopback 健康接口。
 */

import {
	spawn,
	type ChildProcess,
} from "child_process";
import { createHash, randomUUID } from "crypto";
import {
	accessSync,
	chmodSync,
	constants as fsConstants,
	existsSync,
	mkdirSync,
	realpathSync,
} from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";

import {
	assertDshHealthIdentity,
	DshLoopbackGateway,
	DSH_HEALTH_PRODUCT,
	DSH_HEALTH_PROTOCOL_VERSION,
	probeDshHealth,
	type DshGateway,
	type DshHealthIdentity,
	type DshHealthProbe,
} from "./dsh-gateway";
import {
	buildDshLaunchPlan,
	dshBaseUrl,
	dshHomeRoot,
	DSH_HOST,
	parseDshWebToken,
	type DshLaunchPlan,
} from "./dsh-runtime";

export type DshRuntimeState = "stopped" | "starting" | "ready" | "error";

export interface DshProcessManagerOptions {
	getConfiguredExecutable(): string;
	getPort(): number;
	getVaultRoot(): string | null;
	readyTimeoutMs?: number;
	pollIntervalMs?: number;
	stopTimeoutMs?: number;
	runtime?: Partial<DshProcessRuntime>;
}

export interface DshGatewayInput {
	publicPort: number;
	backendPort: number;
	identity: Omit<DshHealthIdentity, "ready">;
}

export interface DshProcessRuntime {
	spawnProcess(plan: DshLaunchPlan, env: Record<string, string>): ChildProcess;
	probeHealth(baseUrl: string): Promise<DshHealthProbe>;
	probeBackend(baseUrl: string): Promise<boolean>;
	allocateBackendPort(): Promise<number>;
	createGateway(input: DshGatewayInput): DshGateway;
	resolveVersion(executable: string): string | Promise<string>;
	createNonce(): string;
	workspaceIdentity(vaultRoot: string): string;
	prepareLaunchPlan(input: {
		executable: string;
		port: number;
		vaultRoot: string;
	}): DshLaunchPlan;
	wait(milliseconds: number): Promise<void>;
	now(): number;
	/**
	 * 进程树终止接缝：默认就是模块级 killProcessTree。单独放进 runtime 是为了让
	 * 单元测试能注入桩（ESM 下无法 vi.spyOn 导出的 spawn，真去 taskkill 假 pid 也无意义）。
	 */
	killProcessTree(pid: number | undefined, graceMs: number): Promise<boolean>;
}

type StateListener = (state: DshRuntimeState, error: string) => void;

// 官方 dsh rc.8 的 process-shutdown 合同最多保留 5 秒完成 dispose。
const DSH_UPSTREAM_SHUTDOWN_TIMEOUT_MS = 5000;
const DSH_SUPERVISOR_SHUTDOWN_GRACE_MS =
	DSH_UPSTREAM_SHUTDOWN_TIMEOUT_MS + 500;
const DSH_MANAGER_STOP_TIMEOUT_MS =
	DSH_SUPERVISOR_SHUTDOWN_GRACE_MS + 1000;

const INHERITED_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"TEMP",
	"TMP",
	"TMPDIR",
	"SystemRoot",
	"WINDIR",
	"ComSpec",
	"PATHEXT",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TERM",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
] as const;

type ExecutableProbe = (candidate: string) => boolean;

function canExecute(candidate: string): boolean {
	try {
		accessSync(candidate, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Finder/LaunchServices 启动的 Obsidian 通常没有包管理器的 PATH，而官方 dsh
 * 入口使用 `#!/usr/bin/env node`。只探测已有 PATH 与固定的本机 Node 安装目录，
 * 不加载交互 shell 配置，也不继承额外环境变量。
 */
export function resolveNodeBinDirectory(
	inherited: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	isExecutable: ExecutableProbe = canExecute
): string | null {
	const pathApi = platform === "win32" ? path.win32 : path.posix;
	const separator = platform === "win32" ? ";" : ":";
	const candidates = (inherited.PATH ?? inherited.Path ?? "")
		.split(separator)
		.filter(Boolean);

	if (platform === "darwin") {
		candidates.push("/opt/homebrew/bin", "/usr/local/bin");
	} else if (platform === "win32") {
		const programFiles = inherited.ProgramFiles?.trim();
		const localAppData = inherited.LOCALAPPDATA?.trim();
		if (programFiles) candidates.push(path.win32.join(programFiles, "nodejs"));
		if (localAppData) {
			candidates.push(path.win32.join(localAppData, "Programs", "nodejs"));
		}
	} else {
		candidates.push("/usr/local/bin", "/usr/bin");
	}

	const binaryName = platform === "win32" ? "node.exe" : "node";
	const seen = new Set<string>();
	for (const rawDirectory of candidates) {
		const directory = rawDirectory.trim();
		if (!directory || seen.has(directory)) continue;
		seen.add(directory);
		if (isExecutable(pathApi.join(directory, binaryName))) return directory;
	}
	return null;
}

export function buildDshChildEnvironment(
	planEnvironment: Record<string, string>,
	inherited: NodeJS.ProcessEnv = process.env,
	nodeBinDirectory: string | null = resolveNodeBinDirectory(inherited),
	platform: NodeJS.Platform = process.platform
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key of INHERITED_ENV_ALLOWLIST) {
		const value = inherited[key];
		if (typeof value === "string" && value) result[key] = value;
	}
	if (nodeBinDirectory) {
		const separator = platform === "win32" ? ";" : ":";
		const entries = (result.PATH ?? "").split(separator).filter(Boolean);
		if (!entries.includes(nodeBinDirectory)) {
			result.PATH = [nodeBinDirectory, ...entries].join(separator);
		}
	}
	if (planEnvironment.DSH_HOME) {
		result.DSH_HOME = planEnvironment.DSH_HOME;
	}
	return result;
}

export function resolveNodeExecutable(
	inherited: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	isExecutable: ExecutableProbe = canExecute
): string {
	const directory = resolveNodeBinDirectory(
		inherited,
		platform,
		isExecutable
	);
	if (!directory) {
		throw new Error("无法启动 dsh：未找到可执行的 Node.js 运行时");
	}
	const pathApi = platform === "win32" ? path.win32 : path.posix;
	return pathApi.join(
		directory,
		platform === "win32" ? "node.exe" : "node"
	);
}

/**
 * Electron 渲染进程退出时不保证 Obsidian 会等待插件的异步 onunload。
 * 由一个只持有 dsh 的轻量 Node 监护进程观察宿主 PID；宿主消失、插件显式
 * stop，或 dsh 自行退出时，监护进程都会收敛，不把随机端口服务留给 PID 1。
 */
export const DSH_PARENT_SUPERVISOR_SOURCE = String.raw`
"use strict";
const { spawn } = require("node:child_process");
const [hostPidRaw, pollIntervalRaw, shutdownGraceRaw, executable, ...args] =
	process.argv.slice(1);
const hostPid = Number(hostPidRaw);
const pollIntervalMs = Number(pollIntervalRaw);
const shutdownGraceMs = Number(shutdownGraceRaw);
if (
	!Number.isInteger(hostPid) ||
	hostPid <= 0 ||
	!Number.isFinite(pollIntervalMs) ||
	pollIntervalMs < 10 ||
	!Number.isFinite(shutdownGraceMs) ||
	shutdownGraceMs < 10 ||
	!executable
) {
	console.error("Invalid TT-Workbench dsh supervisor arguments");
	process.exit(64);
}
const child = spawn(executable, args, {
	cwd: process.cwd(),
	env: process.env,
	stdio: ["ignore", "inherit", "inherit"],
	// Windows 上 npm 装出来的 dsh 是 .cmd 包装脚本，spawn 必须走 shell；
	// macOS / Linux 上 dsh 是带 shebang 的可执行文件，shell=false 即可。
	shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable),
});
let stopping = false;
let forceTimer = null;
let hostTimer = null;
const clearTimers = () => {
	if (hostTimer) clearInterval(hostTimer);
	if (forceTimer) clearTimeout(forceTimer);
	hostTimer = null;
	forceTimer = null;
};
const requestStop = () => {
	if (stopping) return;
	stopping = true;
	if (hostTimer) clearInterval(hostTimer);
	hostTimer = null;
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (process.platform === "win32") {
		// Windows 上 child.kill("SIGTERM") 直接 TerminateProcess，handler 不执行；
		// 而 child 可能是 .cmd（spawn 走 shell）派生的 cmd.exe，只对它发包会漏掉
		// 真正的 node 孙进程。因此整棵树一律 taskkill /T /F（有意跳过优雅关闭）。
		if (!child.pid) return;
		const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
			windowsHide: true,
			stdio: "ignore",
		});
		killer.once("error", () => {});
		return;
	}
	child.kill("SIGTERM");
	forceTimer = setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
	}, shutdownGraceMs);
};
const hostIsAlive = () => {
	if (process.ppid === 1) return false;
	try {
		process.kill(hostPid, 0);
		return true;
	} catch (error) {
		return error && error.code === "EPERM";
	}
};
child.once("error", (error) => {
	clearTimers();
	console.error("TT-Workbench dsh supervisor spawn failed:", error.message);
	process.exit(1);
});
child.once("exit", (code, signal) => {
	clearTimers();
	process.exit(code ?? (signal === "SIGTERM" ? 0 : 1));
});
process.once("SIGTERM", requestStop);
process.once("SIGINT", requestStop);
hostTimer = setInterval(() => {
	if (!hostIsAlive()) requestStop();
}, pollIntervalMs);
`;

export interface DshSupervisorOptions {
	hostPid?: number;
	nodeExecutable?: string;
	pollIntervalMs?: number;
	shutdownGraceMs?: number;
}

export function spawnDshWithParentSupervisor(
	plan: DshLaunchPlan,
	env: Record<string, string>,
	options: DshSupervisorOptions = {}
): ChildProcess {
	const nodeExecutable =
		options.nodeExecutable ?? resolveNodeExecutable(env);
	return spawn(
		nodeExecutable,
		[
			"-e",
			DSH_PARENT_SUPERVISOR_SOURCE,
			"--",
			String(options.hostPid ?? process.pid),
			String(options.pollIntervalMs ?? 250),
			String(
				options.shutdownGraceMs ??
					DSH_SUPERVISOR_SHUTDOWN_GRACE_MS
			),
			plan.executable,
			...plan.args,
		],
		{
			cwd: plan.cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		}
	);
}

export function hasDshProductIdentity(output: string): boolean {
	return (
		/\bdsh\b/i.test(output) &&
		/\bdeepseek(?:\s+|-)harness\b/i.test(output)
	);
}

export function parseDshVersion(output: string): string | null {
	const normalized = output.trim();
	const exact = normalized.match(
		/^v?(\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?)$/i
	);
	if (exact) return exact[1];
	if (!/\b(?:dsh|deepseek(?:\s+|-)?harness)\b/i.test(normalized)) return null;
	return normalized.match(
		/\bv?(\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?)\b/i
	)?.[1] ?? null;
}

const DSH_VERSION_PROBE_TIMEOUT_MS = 5000;

/**
 * 一次性异步子进程（取代原先的同步探测）：只用 spawn，超时后经 `options.kill` 收整棵进程树，
 * 主进程事件循环在等待期间保持可响应。
 *
 * `options.kill` 是注入点，默认复用上面的 killProcessTree——`.cmd` + `shell:true` 场景
 * 只杀直接子进程会留孙进程，等于把「阻塞」换成「泄漏」。
 */
export async function runChildOnce(
	executable: string,
	args: string[],
	options: {
		timeoutMs: number;
		env?: Record<string, string>;
		shell?: boolean;
		kill?: (pid: number | undefined) => Promise<boolean>;
	}
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	const kill = options.kill ?? ((pid: number | undefined) => killProcessTree(pid, 1000));
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		// 仓库约定：window.* 定时器句柄一律用 number（见 view.ts:133）。
		let timer: number | null = null;
		let child: ChildProcess;
		const finish = (status: number | null): void => {
			if (settled) return;
			settled = true;
			if (timer) window.clearTimeout(timer);
			resolve({ status, stdout, stderr });
		};
		try {
			child = spawn(executable, args, {
				env: options.env,
				shell: options.shell ?? false,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch {
			resolve({ status: null, stdout: "", stderr: "" });
			return;
		}
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.once("error", () => finish(null));
		child.once("close", (code) => finish(code));
		timer = window.setTimeout(() => {
			void kill(child.pid);
			finish(null);
		}, options.timeoutMs);
	});
}

async function probeDshOnPath(): Promise<string | null> {
	try {
		const result =
			process.platform === "win32"
				? await runChildOnce("where", ["dsh"], { timeoutMs: DSH_VERSION_PROBE_TIMEOUT_MS })
				: await runChildOnce("sh", ["-c", "command -v dsh"], { timeoutMs: DSH_VERSION_PROBE_TIMEOUT_MS });
		if (result.status !== 0) return null;
		const first = (result.stdout ?? "").split(/\r?\n/)[0]?.trim() ?? "";
		return first || null;
	} catch {
		return null;
	}
}

/**
 * Windows 上 npm 装出来的 dsh 是 .cmd 包装脚本（不是真正的 .exe），
 * Node 的 spawn 直接调用 .cmd / .bat 会抛 EINVAL，
 * 必须显式走 shell；macOS / Linux 上 dsh 是带 shebang 的可执行文件。
 */
function needsShellOnWindows(executable: string): boolean {
	return (
		process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)
	);
}

async function defaultResolveVersion(executable: string): Promise<string> {
	const environment = buildDshChildEnvironment({});
	// Windows 上 npm 装出来的 dsh 是 .cmd 包装脚本（不是真正的 .exe），
	// Node 的 spawn 直接调用 .cmd / .bat 会抛 EINVAL，
	// 必须显式走 shell；macOS / Linux 上 dsh 是带 shebang 的可执行文件。
	const shell = needsShellOnWindows(executable);
	const versionResult = await runChildOnce(executable, ["--version"], {
		env: environment,
		shell,
		timeoutMs: DSH_VERSION_PROBE_TIMEOUT_MS,
	});
	if (versionResult.status !== 0) {
		const diagnostic =
			`${versionResult.stdout ?? ""}\n${versionResult.stderr ?? ""}`;
		if (/env:.*node:.*(?:no such file|not found)/i.test(diagnostic)) {
			throw new Error("无法验证 dsh 产品版本：未找到 Node.js 运行时");
		}
		throw new Error("无法验证 dsh 产品版本");
	}
	const version = parseDshVersion(
		`${versionResult.stdout ?? ""}\n${versionResult.stderr ?? ""}`
	);
	if (!version) throw new Error("dsh --version 未返回有效语义版本");
	const helpResult = await runChildOnce(executable, ["--help"], {
		env: environment,
		shell,
		timeoutMs: DSH_VERSION_PROBE_TIMEOUT_MS,
	});
	const helpOutput =
		`${helpResult.stdout ?? ""}\n${helpResult.stderr ?? ""}`;
	if (helpResult.status !== 0 || !hasDshProductIdentity(helpOutput)) {
		throw new Error("dsh --help 未返回可验证的 DeepSeek Harness 产品身份");
	}
	return version;
}

function defaultWorkspaceIdentity(vaultRoot: string): string {
	const canonical = realpathSync(vaultRoot);
	return createHash("sha256").update(canonical).digest("hex");
}

function defaultPrepareLaunchPlan(input: {
	executable: string;
	port: number;
	vaultRoot: string;
}): DshLaunchPlan {
	const home = dshHomeRoot(os.homedir());
	mkdirSync(home, { recursive: true, mode: 0o700 });
	try {
		chmodSync(home, 0o700);
	} catch {
		/* Windows 无 POSIX 权限位，忽略 */
	}
	return buildDshLaunchPlan({
		executable: input.executable,
		port: input.port,
		dshHome: home,
		vaultRoot: input.vaultRoot,
	});
}

function probeBackend(baseUrl: string): Promise<boolean> {
	return new Promise((resolve) => {
		const request = http.get(baseUrl, (response) => {
			response.resume();
			const status = response.statusCode ?? 500;
			resolve(status >= 200 && status < 400);
		});
		request.on("error", () => resolve(false));
		request.setTimeout(1500, () => {
			request.destroy();
			resolve(false);
		});
	});
}

function allocateBackendPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = http.createServer();
		server.once("error", reject);
		server.listen(0, DSH_HOST, () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("无法分配 Harness 内部端口"));
				return;
			}
			const port = address.port;
			server.close((error) => {
				if (error) reject(error);
				else resolve(port);
			});
		});
	});
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
	if (!isPidAlive(pid)) return Promise.resolve(true);
	return new Promise((resolve) => {
		const deadline = Date.now() + timeoutMs;
		const poll = (): void => {
			if (!isPidAlive(pid)) {
				resolve(true);
				return;
			}
			if (Date.now() >= deadline) {
				resolve(false);
				return;
			}
			window.setTimeout(poll, 25);
		};
		window.setTimeout(poll, 25);
	});
}

/**
 * 对 spawn 时记录的 pid 做进程树终止（报告 A4「停机」处方）。
 *
 * Windows 上 `child.kill("SIGTERM")` 会直接 TerminateProcess、handler 不执行，
 * 而 `shell:true` 让真正的 dsh 成为 cmd.exe 的孙进程；只有 `taskkill /T` 才能把
 * 整棵树收掉。**有意取舍**：win32 直接 `/F` 跳过了上面 DSH_UPSTREAM_SHUTDOWN_TIMEOUT_MS
 * 那套 5s 优雅关闭合同——该平台的优雅关闭本来就不可达，强制终止才回到「进程树真的没了」
 * 这一可验收状态。posix 才走 SIGTERM → graceMs → 仍存活再 SIGKILL。
 *
 * `options.spawn` 是测试注入点（ESM 下无法 vi.spyOn 导出的 spawn）。
 */
export async function killProcessTree(
	pid: number | undefined,
	graceMs: number,
	options: { spawn?: typeof spawn } = {}
): Promise<boolean> {
	// 同时挡 undefined 与 0：process.kill(undefined, 0) 抛 ERR_INVALID_ARG_TYPE，
	// 而 process.kill(0, 0) 不抛，会把整个进程组当成目标。
	if (!pid) return false;
	try {
		process.kill(pid, 0);
	} catch (error) {
		// 先校验存活，防止 PID 复用后误杀无关进程树；EPERM 说明进程存在但无权探测。
		if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
	}
	const spawnImpl = options.spawn ?? spawn;
	if (process.platform === "win32") {
		return await new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (value: boolean): void => {
				if (settled) return;
				settled = true;
				resolve(value);
			};
			let killer: ChildProcess;
			try {
				killer = spawnImpl(
					"taskkill",
					["/PID", String(pid), "/T", "/F"],
					{ windowsHide: true, stdio: "ignore" }
				);
			} catch {
				finish(false);
				return;
			}
			killer.once("error", () => finish(false));
			killer.once("close", (code) => finish(code === 0));
		});
	}
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return false;
	}
	if (await waitForPidExit(pid, graceMs)) return true;
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		return false;
	}
	return await waitForPidExit(pid, graceMs);
}

const DEFAULT_RUNTIME: DshProcessRuntime = {
	spawnProcess: (plan, env) =>
		spawnDshWithParentSupervisor(plan, env),
	probeHealth: (baseUrl) => probeDshHealth(baseUrl),
	probeBackend,
	allocateBackendPort,
	createGateway: (input) =>
		new DshLoopbackGateway(
			input.publicPort,
			input.backendPort,
			input.identity
		),
	resolveVersion: defaultResolveVersion,
	createNonce: () => randomUUID(),
	workspaceIdentity: defaultWorkspaceIdentity,
	prepareLaunchPlan: defaultPrepareLaunchPlan,
	wait: (milliseconds) =>
		new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
	now: () => Date.now(),
	killProcessTree: (pid, graceMs) => killProcessTree(pid, graceMs),
};

export class DshProcessManager {
	private child: ChildProcess | null = null;
	private gateway: DshGateway | null = null;
	private state: DshRuntimeState = "stopped";
	private lastError = "";
	private startPromise: Promise<void> | null = null;
	private lifecycleTail: Promise<void> = Promise.resolve();
	private generation = 0;
	private disposed = false;
	private readonly listeners = new Set<StateListener>();
	private readonly readyTimeoutMs: number;
	private readonly pollIntervalMs: number;
	private readonly stopTimeoutMs: number;
	private readonly runtime: DshProcessRuntime;
	/** 版本号按进程生命周期缓存（报告 C2）：同一次 spawn 生命周期内不再重复探测。 */
	private resolvedVersion: { executable: string; version: string } | null = null;

	constructor(private readonly options: DshProcessManagerOptions) {
		this.readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
		this.pollIntervalMs = options.pollIntervalMs ?? 400;
		this.stopTimeoutMs =
			options.stopTimeoutMs ?? DSH_MANAGER_STOP_TIMEOUT_MS;
		this.runtime = { ...DEFAULT_RUNTIME, ...options.runtime };
	}

	getState(): DshRuntimeState {
		return this.state;
	}

	getLastError(): string {
		return this.lastError;
	}

	getBaseUrl(): string {
		return dshBaseUrl(this.options.getPort());
	}

	onStateChange(listener: StateListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private setState(state: DshRuntimeState, error = ""): void {
		this.state = state;
		this.lastError = error;
		for (const listener of this.listeners) listener(state, error);
	}

	private setStateFor(
		generation: number,
		state: DshRuntimeState,
		error = ""
	): void {
		if (generation === this.generation && !this.disposed) {
			this.setState(state, error);
		}
	}

	async resolveExecutable(): Promise<string> {
		const configured = this.options.getConfiguredExecutable().trim();
		if (configured) {
			if (!existsSync(configured)) {
				throw new Error(`设置的 dsh 路径不存在：${configured}`);
			}
			return configured;
		}
		const detected = await probeDshOnPath();
		if (!detected) {
			throw new Error(
				"未找到 dsh CLI。请先安装 DeepSeek Harness，或在设置页填写 dsh 可执行路径。"
			);
		}
		return detected;
	}

	async ensureStarted(): Promise<void> {
		if (this.disposed) throw new Error("Harness 进程管理器已卸载");
		if (this.state === "ready") return;
		if (this.startPromise) return this.startPromise;
		const generation = ++this.generation;
		const task = this.enqueue(() => this.doStart(generation));
		this.startPromise = task;
		const clear = (): void => {
			if (this.startPromise === task) this.startPromise = null;
		};
		void task.then(clear, clear);
		return task;
	}

	async restart(): Promise<void> {
		if (this.disposed) throw new Error("Harness 进程管理器已卸载");
		const generation = ++this.generation;
		const task = this.enqueue(async () => {
			await this.stopManagedResources();
			if (generation === this.generation && !this.disposed) {
				await this.doStart(generation);
			}
		});
		this.startPromise = task;
		const clear = (): void => {
			if (this.startPromise === task) this.startPromise = null;
		};
		void task.then(clear, clear);
		return task;
	}

	async stop(): Promise<void> {
		const generation = ++this.generation;
		this.startPromise = null;
		return this.enqueue(async () => {
			await this.stopManagedResources();
			if (generation === this.generation && !this.disposed) {
				this.setState("stopped");
			}
		});
	}

	dispose(): Promise<void> {
		if (this.disposed) return this.lifecycleTail;
		this.disposed = true;
		++this.generation;
		this.startPromise = null;
		this.resolvedVersion = null;
		this.gateway?.setReady(false);
		void this.gateway?.close();
		if (this.child && this.child.exitCode === null) {
			void this.runtime.killProcessTree(this.child.pid, this.stopTimeoutMs);
		}
		this.setState("stopped");
		return this.enqueue(() => this.stopManagedResources());
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		const task = this.lifecycleTail.then(operation, operation);
		this.lifecycleTail = task.catch(() => {});
		return task;
	}

	private async doStart(generation: number): Promise<void> {
		if (generation !== this.generation || this.disposed) return;
		this.setStateFor(generation, "starting");
		let child: ChildProcess | null = null;
		let gateway: DshGateway | null = null;
		try {
			const vaultRoot = this.options.getVaultRoot();
			if (!vaultRoot) {
				throw new Error("当前 Vault 不是文件系统库，无法锁定 harness 工作区");
			}
			const workspaceId = this.runtime.workspaceIdentity(vaultRoot);
			const occupied = await this.runtime.probeHealth(this.getBaseUrl());
			if (generation !== this.generation || this.disposed) return;
			if (occupied.reachable) {
				if (
					occupied.identity &&
					occupied.identity.workspaceId !== workspaceId
				) {
					throw new Error("Harness 工作区身份不匹配，拒绝复用已占用端口");
				}
				throw new Error("Harness 端口已被未知或非本实例服务占用");
			}

			const executable = await this.resolveExecutable();
			const harnessVersion = await this.resolveVersionCached(executable);
			let backendPort = await this.runtime.allocateBackendPort();
			if (backendPort === this.options.getPort()) {
				backendPort = await this.runtime.allocateBackendPort();
			}
			const identity: Omit<DshHealthIdentity, "ready"> = {
				product: DSH_HEALTH_PRODUCT,
				protocolVersion: DSH_HEALTH_PROTOCOL_VERSION,
				harnessVersion,
				instanceNonce: this.runtime.createNonce(),
				workspaceId,
			};
			gateway = this.runtime.createGateway({
				publicPort: this.options.getPort(),
				backendPort,
				identity,
			});
			await gateway.start();
			if (generation !== this.generation || this.disposed) {
				await gateway.close();
				return;
			}
			this.gateway = gateway;

			const plan = this.runtime.prepareLaunchPlan({
				executable,
				port: backendPort,
				vaultRoot,
			});
			child = this.runtime.spawnProcess(
				plan,
				buildDshChildEnvironment(plan.env)
			);
			if (generation !== this.generation || this.disposed) {
				await this.terminateChild(child);
				await gateway.close();
				return;
			}
			this.child = child;
			let stderrTail = "";
			let stdoutTail = "";
			let webToken: string | null = null;
			let exitError = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				// dsh >= 0.1.2 的 web 启动行打印在 stdout：
				//   dsh web: http://127.0.0.1:<port>/?token=<token>
				if (webToken) return;
				const output = stdoutTail + chunk.toString("utf8");
				webToken = parseDshWebToken(output, dshBaseUrl(backendPort));
				// Parse before trimming so a long log chunk cannot discard the launch banner.
				// Retain only an incomplete line; never expose the token in diagnostics.
				stdoutTail = webToken ? "" : (output.split("\n").at(-1) ?? "").slice(-2000);
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
			});
			const exitMessage = (code: number | null): string =>
				`dsh 进程退出（code ${code ?? "?"}）${
					stderrTail ? `：${stderrTail.slice(-300)}` : ""
				}`;
			child.once("exit", (code) => {
				exitError = exitMessage(code);
				if (
					generation !== this.generation ||
					this.child !== child ||
					this.disposed
				) {
					return;
				}
				this.child = null;
				gateway?.setReady(false);
				if (this.gateway === gateway) this.gateway = null;
				void gateway?.close();
				this.setState("error", exitError);
			});
			child.once("error", (error) => {
				exitError = `dsh 启动失败：${error.message}`;
				if (
					generation === this.generation &&
					this.child === child &&
					!this.disposed
				) {
					this.setState("error", exitError);
				}
			});

			await this.waitForBackendReady(
				generation,
				dshBaseUrl(backendPort),
				() => exitError,
				() => webToken,
				gateway
			);
			if (generation !== this.generation || this.disposed) {
				await this.cleanupOwned(child, gateway);
				return;
			}
			gateway.setReady(true);
			const verified = await this.runtime.probeHealth(this.getBaseUrl());
			assertDshHealthIdentity(verified, identity, true);
			this.setStateFor(generation, "ready");
		} catch (error) {
			if (child || gateway) await this.cleanupOwned(child, gateway);
			if (generation !== this.generation || this.disposed) return;
			const message = error instanceof Error ? error.message : String(error);
			this.setState("error", message);
			throw error;
		}
	}

	private async waitForBackendReady(
		generation: number,
		baseUrl: string,
		getExitError: () => string,
		getWebToken: () => string | null,
		gateway: DshGateway
	): Promise<void> {
		const deadline = this.runtime.now() + this.readyTimeoutMs;
		while (this.runtime.now() < deadline) {
			if (generation !== this.generation || this.disposed) return;
			const exitError = getExitError();
			if (exitError) throw new Error(exitError);
			// dsh >= 0.1.2：web 根路径需 token/cookie，永远不返回 2xx，
			// 就绪信号改为「stdout 启动横幅里的 ?token= + 一次成功的 cookie 握手」。
			// 旧版（<= 0.1.0）无认证，横幅不含 token，退回 probeBackend 轮询根路径 2xx。
			const token = getWebToken();
			if (token) {
				await gateway.tryTokenHandshake(token, baseUrl);
				if (gateway.hasAuthCookie) return;
				// 横幅已打印但服务尚未响应（握手未拿到 cookie）：继续轮询。
			} else if (await this.runtime.probeBackend(baseUrl)) {
				return;
			}
			await this.runtime.wait(this.pollIntervalMs);
		}
		throw new Error(
			`dsh web 在 ${Math.round(this.readyTimeoutMs / 1000)} 秒内未就绪`
		);
	}

	private async resolveVersionCached(executable: string): Promise<string> {
		const cached = this.resolvedVersion;
		if (cached && cached.executable === executable) return cached.version;
		const version = await this.runtime.resolveVersion(executable);
		this.resolvedVersion = { executable, version };
		return version;
	}

	private async cleanupOwned(
		child: ChildProcess | null,
		gateway: DshGateway | null
	): Promise<void> {
		if (this.child === child) this.child = null;
		if (this.gateway === gateway) this.gateway = null;
		gateway?.setReady(false);
		await gateway?.close();
		if (child) await this.terminateChild(child);
	}

	private async stopManagedResources(): Promise<void> {
		const child = this.child;
		const gateway = this.gateway;
		this.child = null;
		this.gateway = null;
		gateway?.setReady(false);
		await gateway?.close();
		if (child) await this.terminateChild(child);
	}

	private async terminateChild(child: ChildProcess): Promise<void> {
		if (child.exitCode !== null || child.signalCode !== null) return;
		// 统一走 killProcessTree（报告 A4 要求 :253/:608/:807 三处同一 helper）：
		// Windows 上必须先 taskkill /T /F，任何先行的 SIGTERM 都会让 wrapper 提前退出，
		// 使随后的 taskkill 报「找不到进程」而留下 node 孙进程。
		await this.runtime.killProcessTree(child.pid, this.stopTimeoutMs);
		await this.waitForChildExit(child, this.stopTimeoutMs);
	}

	private waitForChildExit(
		child: ChildProcess,
		timeoutMs: number
	): Promise<boolean> {
		if (child.exitCode !== null || child.signalCode !== null) {
			return Promise.resolve(true);
		}
		return new Promise((resolve) => {
			let settled = false;
			const finish = (value: boolean): void => {
				if (settled) return;
				settled = true;
				child.off("exit", onExit);
				window.clearTimeout(timer);
				resolve(value);
			};
			const onExit = (): void => finish(true);
			const timer = window.setTimeout(() => finish(false), timeoutMs);
			child.once("exit", onExit);
		});
	}
}
