import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as nodeSetTimeout } from "node:timers/promises";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { killProcessTree } from "../src/harness/dsh-process-manager";

const isWindows = process.platform === "win32";

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 5000
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await nodeSetTimeout(25);
	}
	return predicate();
}

const directories: string[] = [];

afterEach(async () => {
	while (directories.length > 0) {
		const directory = directories.pop();
		if (!directory) continue;
		// win32 上子进程被 SIGKILL 后，句柄释放比进程退出更慢；紧接着 rmdir 会偶发
		// EBUSY。这属于清理时序而非产品行为，重试几次再兜底放弃，避免把测试标红。
		for (let attempt = 0; attempt < 5; attempt += 1) {
			try {
				await rm(directory, { recursive: true, force: true });
				break;
			} catch (error) {
				if (attempt === 4) {
					// 清理失败不影响断言结论，但也别静默吞掉：留一条可检索的痕迹。
					console.warn(`[harness-process-tree] 临时目录清理失败：${String(error)}`);
					break;
				}
				await nodeSetTimeout(50 * (attempt + 1));
			}
		}
	}
});

/**
 * Q-QUA6 的验收：supervisor → wrapper → 真正的 node 孙进程 三层树，
 * 对 supervisor 的 pid 调 killProcessTree 后孙进程必须消失（process.kill 抛 ESRCH）。
 *
 * win32 上 wrapper 刻意用 `.cmd` + shell:true（与生产 `needsShellOnWindows` 同形状）：
 * 此时只对 cmd.exe 发 SIGTERM 会留下 node 孙进程，先 SIGTERM 再 taskkill 也会因
 * 「找不到进程」(exit 128) 失败 —— 这正是本项要修的顺序问题。
 */
describe("Harness process tree termination", () => {
	it("kills the whole spawned tree so no grandchild survives", async () => {
		const directory = await mkdtemp(join(tmpdir(), "talos-tree-"));
		directories.push(directory);
		const grandchildScript = join(directory, "grandchild.mjs");
		const wrapperScript = join(directory, "wrapper.mjs");
		const wrapperCmd = join(directory, "wrapper.cmd");
		const pidFile = join(directory, "grandchild.pid");
		const tickFile = join(directory, "grandchild.ticks");

		// 孙进程：每 250ms 打一个 tick（用于证明它一直在跑），SIGTERM handler 只吸收信号
		// 不做退出 —— 与 Windows 上 handler 不执行的情形一致，强制终止才收得掉。
		await writeFile(
			grandchildScript,
			[
				'import { appendFileSync, writeFileSync } from "node:fs";',
				"writeFileSync(process.argv[2], String(process.pid));",
				'process.on("SIGTERM", () => {});',
				`setInterval(() => appendFileSync(process.argv[3], "tick\\n"), 250);`,
			].join("\n"),
			"utf8"
		);
		// wrapper：再 spawn 一层，模拟 `.cmd` 包装脚本派生出真正的 dsh。
		await writeFile(
			wrapperScript,
			[
				'import { spawn } from "node:child_process";',
				'const child = spawn(process.execPath, [process.argv[2], process.argv[3], process.argv[4]], { stdio: "ignore" });',
				'child.on("exit", (code) => process.exit(code ?? 0));',
				"setInterval(() => {}, 1000);",
			].join("\r\n"),
			"utf8"
		);
		await writeFile(
			wrapperCmd,
			`@echo off\r\n"${process.execPath}" "${wrapperScript}" %*\r\n`,
			"utf8"
		);

		const spawnWrapper = (): ChildProcess =>
			isWindows
				? // 生产形状：`.cmd` 必须走 shell，于是 wrapper 自己成了 cmd.exe，node 是孙进程。
					spawn(wrapperCmd, [grandchildScript, pidFile, tickFile], {
						stdio: "ignore",
						cwd: directory,
						shell: true,
					})
				: spawn(process.execPath, [wrapperScript, grandchildScript, pidFile, tickFile], {
					stdio: "ignore",
				});

		const wrapper = spawnWrapper();
		let grandchildPid = 0;
		try {
			const started = await waitUntil(async () => {
				try {
					grandchildPid = Number(await readFile(pidFile, "utf8"));
					return Number.isInteger(grandchildPid) && grandchildPid > 0;
				} catch {
					return false;
				}
			});
			expect(started).toBe(true);
			expect(processExists(grandchildPid)).toBe(true);
			// 让 tick 真的跑起来，证明孙进程还活着。
			expect(await waitUntil(async () => {
				try {
					return (await readFile(tickFile, "utf8")).length > 0;
				} catch {
					return false;
				}
			})).toBe(true);

			// 对 wrapper（中间层）的 pid 收整棵树。
			const killed = await killProcessTree(wrapper.pid, 1000);
			expect(killed).toBe(true);
			expect(await waitUntil(() => !processExists(grandchildPid), 5000)).toBe(true);
			// 孙进程真的没了：对它的 pid 发 0 号信号抛 ESRCH。
			expect(() => process.kill(grandchildPid, 0)).toThrow();
		} finally {
			if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGKILL");
			if (grandchildPid > 0 && processExists(grandchildPid)) {
				process.kill(grandchildPid, "SIGKILL");
			}
		}
	}, 30000);

	it("returns false for a missing or non-positive pid without spawning a killer", async () => {
		const spawnStub = vi.fn();
		expect(await killProcessTree(undefined, 100, { spawn: spawnStub as never })).toBe(false);
		// 0 必须被挡住：process.kill(0, 0) 不抛，会把整个进程组当目标。
		expect(await killProcessTree(0, 100, { spawn: spawnStub as never })).toBe(false);
		expect(spawnStub).not.toHaveBeenCalled();
	});

	it("uses taskkill /T /F as the first step on win32", async () => {
		if (!isWindows) return;
		const calls: Array<{ command: string; args: readonly string[] }> = [];
		const spawnStub = (_command: string, args: readonly string[]) => {
			calls.push({ command: _command, args });
			const killer = new EventEmitter() as EventEmitter & { pid: number };
			killer.pid = 9001;
			void nodeSetTimeout(5).then(() => killer.emit("close", 0));
			return killer;
		};
		// 用本进程自己的 pid 通过存活校验（真实存在），终止器是桩，不会真杀。
		const ok = await killProcessTree(process.pid, 100, {
			spawn: spawnStub as never,
		});
		expect(ok).toBe(true);
		expect(calls).toEqual([
			{ command: "taskkill", args: ["/PID", String(process.pid), "/T", "/F"] },
		]);
	});
});
