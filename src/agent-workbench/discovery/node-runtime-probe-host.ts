import { access, constants, open } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { clearTimeout as cancelTimeout, setTimeout as scheduleTimeout } from "node:timers";
import type { RuntimeId } from "../contracts/runtime-adapter";
import type { ProbeCommandResult, ProtocolHandshake, RuntimeProbeHost } from "./runtime-discovery-service";

const WINDOWS_RUNTIME_EXTENSIONS = [".exe", ".cmd", ".bat", ".com"];
const WINDOWS_TEXT_SHIM_EXTENSIONS = new Set([".cmd", ".bat"]);

function windowsExtensions(pathext = ""): string[] {
	return (pathext || WINDOWS_RUNTIME_EXTENSIONS.join(";"))
		.split(";")
		.map((extension) => extension.trim().toLowerCase())
		.filter(Boolean)
		.map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
}

/** 只读文件头两字节判定 PE（`MZ`）。不整文件读入，也不用 `access(X_OK)`。 */
async function windowsPortableExecutable(candidate: string): Promise<boolean> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(candidate, "r");
		const header = Buffer.alloc(2);
		const { bytesRead } = await handle.read(header, 0, 2, 0);
		return bytesRead === 2 && header[0] === 0x4d && header[1] === 0x5a;
	} catch {
		return false;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/**
 * 可执行判定。win32 上 `constants.X_OK` 对纯文本文件恒真（实测），
 * 于是 `omp` 这种文本 shim 会冒充可执行、随后 spawn 报 ENOENT。因此 win32
 * 走「扩展名 ∈ WINDOWS_RUNTIME_EXTENSIONS ∪ PATHEXT」且「.exe 需 MZ 魔数」；
 * `.cmd`/`.bat` 是文本 shim，豁免魔数只看扩展名。posix 保留 X_OK。
 */
async function executable(candidate: string, platform: NodeJS.Platform, pathext = ""): Promise<boolean> {
	if (platform !== "win32") {
		try { await access(candidate, constants.X_OK); return true; } catch { return false; }
	}
	const extension = path.win32.extname(candidate).toLowerCase();
	if (!extension) return false;
	const allowed = new Set([...WINDOWS_RUNTIME_EXTENSIONS, ...windowsExtensions(pathext)]);
	if (!allowed.has(extension)) return false;
	if (WINDOWS_TEXT_SHIM_EXTENSIONS.has(extension)) {
		try { await access(candidate, constants.F_OK); return true; } catch { return false; }
	}
	return windowsPortableExecutable(candidate);
}

export type ProbeEnvironment = Partial<Pick<
	NodeJS.ProcessEnv,
	"PATH" | "HOME" | "TMPDIR" | "LANG" | "PATHEXT" | "ComSpec" | "SystemRoot" | "WINDIR" | "APPDATA" | "LOCALAPPDATA" | "USERPROFILE"
>>;

export function runtimeCandidateNames(
	candidate: string,
	platform: NodeJS.Platform,
	pathext = "",
): string[] {
	if (platform !== "win32" || path.win32.extname(candidate)) return [candidate];
	// 扩展名优先：裸名垫底。win32 上裸名可能命中一个纯文本 shim（或不存在的名字），
	// 让 `.exe`/`.cmd` 先被选中才止得住 spawn ENOENT → status: crashed 那条链。
	return [...windowsExtensions(pathext).map((extension) => `${candidate}${extension}`), candidate];
}

export function runtimeProbeUsesShell(
	executablePath: string,
	platform: NodeJS.Platform,
): boolean {
	return platform === "win32" && /\.(?:cmd|bat)$/i.test(executablePath);
}

export function safeWindowsCommandShimPath(executablePath: string): boolean {
	return !/[\r\n"&|<>^%!()]/.test(executablePath);
}

export function desktopRuntimeSearchDirectories(
	environment: ProbeEnvironment = process.env,
	platform: NodeJS.Platform = process.platform,
): string[] {
	const directories = (environment.PATH ?? "").split(path.delimiter).filter(Boolean);
	const home = (environment.HOME ?? environment.USERPROFILE)?.trim();
	if (home) {
		directories.push(
			path.join(home, ".local", "bin"),
			path.join(home, ".bun", "bin"),
		);
	}
	if (platform === "win32") {
		if (environment.APPDATA) directories.push(path.join(environment.APPDATA, "npm"));
	} else {
		directories.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin");
	}
	return [...new Set(directories)];
}

export function desktopRuntimePath(
	executablePath: string,
	environment: ProbeEnvironment = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	return [...new Set([path.dirname(executablePath), ...desktopRuntimeSearchDirectories(environment, platform)])]
		.filter(Boolean)
		.join(path.delimiter);
}

export class NodeRuntimeProbeHost implements RuntimeProbeHost {
	constructor(
		private readonly environment: ProbeEnvironment = process.env,
		private readonly platform: NodeJS.Platform = process.platform,
	) {}

	private searchDirectories(): string[] {
		return desktopRuntimeSearchDirectories(this.environment, this.platform);
	}

	private childEnvironment(executablePath: string): NodeJS.ProcessEnv {
		const copied = ["HOME", "TMPDIR", "LANG", "PATHEXT", "ComSpec", "SystemRoot", "WINDIR", "APPDATA", "LOCALAPPDATA", "USERPROFILE"] as const;
		const environment: NodeJS.ProcessEnv = {
			PATH: desktopRuntimePath(executablePath, this.environment, this.platform),
		};
		for (const key of copied) {
			const value = this.environment[key];
			if (value) environment[key] = value;
		}
		return environment;
	}

	async resolve(candidates: string[]): Promise<string | null> {
		const directories = this.searchDirectories();
		const pathext = this.environment.PATHEXT;
		for (const candidate of candidates) {
			for (const expanded of runtimeCandidateNames(candidate, this.platform, pathext)) {
				if (path.isAbsolute(expanded) && await executable(expanded, this.platform, pathext)) return expanded;
				if (!path.isAbsolute(expanded)) {
					for (const directory of directories) {
						const resolved = path.join(directory, expanded);
						if (await executable(resolved, this.platform, pathext)) return resolved;
					}
				}
			}
		}
		return null;
	}

	run(executablePath: string, args: string[], timeoutMs: number): Promise<ProbeCommandResult> {
		const shell = runtimeProbeUsesShell(executablePath, this.platform);
		if (shell && !safeWindowsCommandShimPath(executablePath)) {
			return Promise.reject(new Error("Windows runtime command shim 路径包含不安全 shell 元字符"));
		}
		return new Promise((resolve, reject) => {
			const child = spawn(executablePath, args, {
				shell,
				stdio: ["ignore", "pipe", "pipe"],
				env: this.childEnvironment(executablePath),
				windowsHide: true,
			});
			let stdout = ""; let stderr = ""; let settled = false;
			const timer = scheduleTimeout(() => { if (!settled) { child.kill("SIGTERM"); reject(new Error("运行时探测超时")); } }, timeoutMs);
			child.stdout.on("data", (chunk) => { stdout += String(chunk); });
			child.stderr.on("data", (chunk) => { stderr += String(chunk); });
			child.once("error", (error) => { settled = true; cancelTimeout(timer); reject(error); });
			child.once("close", (code) => { settled = true; cancelTimeout(timer); resolve({ exitCode: code ?? -1, stdout, stderr }); });
		});
	}

	async handshake(runtimeId: RuntimeId, executablePath: string, timeoutMs: number): Promise<ProtocolHandshake> {
		const args = runtimeId === "ohmypi" ? ["--mode", "rpc", "--help"] : ["--help"];
		const result = await this.run(executablePath, args, timeoutMs);
		if (result.exitCode !== 0) return "degraded";
		return "ready";
	}
}
