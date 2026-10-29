import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { desktopRuntimePath, NodeRuntimeProbeHost } from "../src/agent-workbench/discovery/node-runtime-probe-host";
import { RuntimeDiscoveryService } from "../src/agent-workbench/discovery/runtime-discovery-service";
import { cleanupRuntimeStatusFiles } from "../src/agent-workbench/discovery/desktop-runtime-factory";

const isWindows = process.platform === "win32";

/**
 * 造一个可执行的假运行时。win32 上 `#!/bin/sh` 脚本不可直接 spawn，
 * 且探针在 win32 走「扩展名 ∈ WINDOWS_RUNTIME_EXTENSIONS ∪ PATHEXT 且
 * .exe 需 MZ 魔数」，因此 win32 写 `.cmd` 包装（文本 shim 豁免魔数），
 * POSIX 才用 sh 脚本。返回实际写入的路径。
 */
async function fakeRuntime(file: string, version: string): Promise<string> {
	const target = isWindows ? `${file}.cmd` : file;
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(
		target,
		isWindows
			? `@echo off\r\nif "%~1"=="--version" echo ${version}\r\nexit /b 0\r\n`
			: `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "${version}"
fi
exit 0
`
	);
	await chmod(target, 0o755);
	return target;
}

describe("desktop runtime discovery", () => {
	it("removes expired runtime status files without touching live or malformed records", async () => {
		const runtimeTemp = await mkdtemp(path.join(tmpdir(), "talos-runtime-status-"));
		const status = path.join(runtimeTemp, ".agent-cockpit", "status");
		await mkdir(status, { recursive: true });
		const expired = path.join(status, "expired.json");
		const live = path.join(status, "live.json");
		const malformed = path.join(status, "malformed.json");
		await writeFile(expired, JSON.stringify({ expiresAt: "2026-08-28T00:00:00.000Z" }));
		await writeFile(live, JSON.stringify({ expiresAt: "2026-08-30T00:00:00.000Z" }));
		await writeFile(malformed, "not json");
		try {
			await expect(cleanupRuntimeStatusFiles(runtimeTemp, Date.parse("2026-08-29T00:00:00.000Z"))).resolves.toBe(1);
			await expect(access(expired)).rejects.toThrow();
			await expect(access(live)).resolves.toBeUndefined();
			await expect(access(malformed)).resolves.toBeUndefined();
		} finally {
			await rm(runtimeTemp, { recursive: true, force: true });
		}
	});

	it("finds OhMyPi in user bins when the GUI PATH is restricted", async () => {
		const home = await mkdtemp(path.join(tmpdir(), "talos-runtime-home-"));
		try {
			const executable = await fakeRuntime(path.join(home, ".bun/bin/omp"), "omp 0.32.1");
			const service = new RuntimeDiscoveryService(new NodeRuntimeProbeHost({
				PATH: "/usr/bin:/bin",
				HOME: home,
				TMPDIR: tmpdir(),
				LANG: "en_US.UTF-8",
			}));

			const ohmypi = await service.probe("ohmypi");

			expect(ohmypi).toMatchObject({ status: "ready", executable });
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("keeps user runtime bins available to spawned RPC processes", () => {
		const home = path.join(tmpdir(), "synthetic-runtime-home");
		const runtime = path.join(home, ".bun/bin/omp");
		const value = desktopRuntimePath(runtime, { PATH: "/usr/bin:/bin", HOME: home });
		expect(value.split(path.delimiter)).toContain(path.join(home, ".local/bin"));
		expect(value.split(path.delimiter)).toContain(path.join(home, ".bun/bin"));
		expect(value.split(path.delimiter)[0]).toBe(path.dirname(runtime));
	});

	// win32 专属：`access(X_OK)` 在 win32 对纯文本文件恒真，裸名候选会被文本 shim
	// 抢占，随后 spawn 报 ENOENT。本用例钉住「扩展名优先 + 可执行判定」两处修复。
	// skipIf 保证报告 A5 把 test job 放进 ubuntu matrix 时不误红。
	it.skipIf(process.platform !== "win32")(
		"prefers an executable shim over a plain-text bare name on win32",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "talos-runtime-shim-"));
			try {
				// 裸名是纯文本（不是可执行），`.cmd` 才是真正的 shim。
				await writeFile(path.join(root, "omp"), "not an executable");
				const shim = await fakeRuntime(path.join(root, "omp"), "omp 0.32.1");
				const host = new NodeRuntimeProbeHost({ PATH: root, HOME: root, TMPDIR: tmpdir(), PATHEXT: ".COM;.EXE;.BAT;.CMD" });

				await expect(host.resolve(["omp"])).resolves.toBe(shim);
				const result = await host.run(shim, ["--version"], 10_000);
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("omp 0.32.1");
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);
});
