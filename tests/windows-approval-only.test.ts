import { describe, expect, it } from "vitest";
import { ProcessSandbox } from "../src/agent-workbench/security/process-sandbox";
import type { SandboxProbeHost } from "../src/agent-workbench/security/process-sandbox";
import { auditRecord } from "../src/agent-workbench/security/security-audit";
import type { ActionRequest } from "../src/agent-workbench/contracts/approval";

const probe = (available = true): SandboxProbeHost => ({ available: async () => available });

describe("Windows 无隔离执行后端(审批模式)", () => {
	it("默认关闭:未显式开启时 Windows 仍失败关闭", async () => {
		const sandbox = new ProcessSandbox(probe(), "win32");
		const availability = await sandbox.availability();
		expect(availability.available).toBe(false);
		if (!availability.available) {
			expect(availability.reason).toBe("approval-only-disabled");
			expect(availability.message).toContain("无隔离执行");
		}
	});

	it("显式开启后可用,但必须标注 osIsolation=false", async () => {
		const sandbox = new ProcessSandbox(probe(), "win32", { enabled: true });
		const availability = await sandbox.availability();
		expect(availability).toMatchObject({
			available: true,
			backend: "windows-approval-only",
			osIsolation: false,
		});
	});

	it("approval-only 后端不构造任何假隔离:原样返回启动参数", async () => {
		const sandbox = new ProcessSandbox(probe(), "win32", { enabled: true });
		const runtime = {
			executable: "C:\\bin\\omp.exe",
			args: ["--mode", "rpc"],
			cwd: "C:\\vault",
			environment: { PATH: "x" },
			deniedVaultSubpaths: ["private-config"],
			denyDotEnvFiles: true,
		};
		const prepared = await sandbox.prepare(runtime, "C:\\vault");
		// 不得改写成 sandbox-exec 之类"看似隔离"的包装
		expect(prepared.executable).toBe("C:\\bin\\omp.exe");
		expect(prepared.args).toEqual(["--mode", "rpc"]);
		expect(prepared.executable).not.toContain("sandbox");
	});

	it("macOS 永远不会降级到无隔离后端", async () => {
		const sandbox = new ProcessSandbox(probe(), "darwin", { enabled: true });
		const availability = await sandbox.availability();
		// macOS 走 Seatbelt 而不是 approval-only
		expect(availability).toMatchObject({ available: true, backend: "macos-seatbelt", osIsolation: true });
	});

	it("Linux 即使开启该偏好也不可用(仅 Windows 支持)", async () => {
		const sandbox = new ProcessSandbox(probe(), "linux", { enabled: true });
		const availability = await sandbox.availability();
		expect(availability.available).toBe(false);
	});

	it("macOS 缺少 sandbox-exec 时仍然失败关闭", async () => {
		const sandbox = new ProcessSandbox(probe(false), "darwin", { enabled: true });
		const availability = await sandbox.availability();
		expect(availability.available).toBe(false);
		if (!availability.available) expect(availability.reason).toBe("backend-missing");
	});
});

describe("无隔离模式的明文命令审计", () => {
	const request = (): ActionRequest => ({
		actionId: "a1",
		runtimeId: "ohmypi",
		canonicalToolId: "talos.bash",
		kind: "command",
		targets: [{ raw: "rm -rf build", canonical: "rm -rf build" }],
		command: { executable: "bash", args: ["-lc", "rm -rf build"], cwd: "/vault" },
		destructive: true,
	});

	const decision = { actionId: "a1", decision: "allow" as const, reason: "ok", reasonCode: "user-allow" };

	it("默认不记录明文命令行(有隔离后端保持脱敏)", () => {
		const record = auditRecord(request(), decision);
		expect(record.plainCommand).toBeUndefined();
		expect(record.targetDigests).toHaveLength(1);
	});

	it("显式开启时记录完整 executable/args/cwd", () => {
		const record = auditRecord(request(), decision, { includePlainCommand: true });
		expect(record.plainCommand).toEqual({
			executable: "bash",
			args: ["-lc", "rm -rf build"],
			cwd: "/vault",
		});
	});

	it("无 command 的动作即使开启也不产生空字段", () => {
		const readRequest: ActionRequest = { ...request(), kind: "read", command: undefined };
		const record = auditRecord(readRequest, decision, { includePlainCommand: true });
		expect(record.plainCommand).toBeUndefined();
	});
});
