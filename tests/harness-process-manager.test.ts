import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import {
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearTimeout as nodeClearTimeout,
	setTimeout as nodeSetTimeout,
} from "node:timers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Q-PER7：doStart 全程不得使用同步子进程。ESM 下无法 vi.spyOn 导出的 spawn，
// 因此用 vi.mock 包一层计数桩；spawn 仍直通真实实现（本文件后面要真起进程树）。
const childProcessCalls = vi.hoisted(() => ({ spawnSync: 0 }));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawnSync: (...args: Parameters<typeof actual.spawnSync>) => {
			childProcessCalls.spawnSync += 1;
			return actual.spawnSync(...args);
		},
		default: actual,
	};
});

import {
	assertDshHealthIdentity,
	DshLoopbackGateway,
	DSH_HEALTH_PRODUCT,
	DSH_HEALTH_PROTOCOL_VERSION,
	probeDshHealth,
	type DshGateway,
	type DshHealthIdentity,
} from "../src/harness/dsh-gateway";
import {
	buildDshChildEnvironment,
	DshProcessManager,
	hasDshProductIdentity,
	parseDshVersion,
	resolveNodeBinDirectory,
	resolveNodeExecutable,
	spawnDshWithParentSupervisor,
	type DshGatewayInput,
	type DshProcessRuntime,
} from "../src/harness/dsh-process-manager";
import {
	buildDshLaunchPlan,
	dshBaseUrl,
	parseDshWebToken,
	type DshLaunchPlan,
} from "../src/harness/dsh-runtime";

const WORKSPACE_A = "a".repeat(64);
const WORKSPACE_B = "b".repeat(64);

beforeAll(() => {
	vi.stubGlobal("window", {
		setTimeout: nodeSetTimeout,
		clearTimeout: nodeClearTimeout,
	});
});

afterAll(() => vi.unstubAllGlobals());

function identity(workspaceId = WORKSPACE_A): Omit<DshHealthIdentity, "ready"> {
	return {
		product: DSH_HEALTH_PRODUCT,
		protocolVersion: DSH_HEALTH_PROTOCOL_VERSION,
		harnessVersion: "0.1.0-rc.8",
		instanceNonce: "nonce-000000000001",
		workspaceId,
	};
}

async function listen(
	server: http.Server
): Promise<{ port: number; close: () => Promise<void> }> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const port = (server.address() as AddressInfo).port;
	return {
		port,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}

async function waitUntil(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 3000
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await new Promise<void>((resolve) => nodeSetTimeout(resolve, 25));
	}
	return predicate();
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForExit(
	child: ChildProcess,
	timeoutMs = 3000
): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return true;
	return new Promise((resolve) => {
		const timer = nodeSetTimeout(() => {
			child.off("exit", onExit);
			resolve(false);
		}, timeoutMs);
		const onExit = (): void => {
			nodeClearTimeout(timer);
			resolve(true);
		};
		child.once("exit", onExit);
	});
}

class FakeChild extends EventEmitter {
	readonly stderr = new EventEmitter();
	readonly stdout = new EventEmitter();
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killed = false;
	readonly signals: NodeJS.Signals[] = [];

	constructor(readonly pid = 4242) {
		super();
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.killed = true;
		this.signals.push(signal);
		queueMicrotask(() => {
			if (this.exitCode !== null || this.signalCode !== null) return;
			this.exitCode = 0;
			this.signalCode = signal;
			this.emit("exit", 0, signal);
		});
		return true;
	}

	/** 模拟进程树终止器把整棵树收掉（Q-QUA6 后终止不再经 child.kill）。 */
	terminate(): void {
		if (this.exitCode !== null || this.signalCode !== null) return;
		this.exitCode = 0;
		this.signalCode = "SIGKILL";
		queueMicrotask(() => this.emit("exit", 0, "SIGKILL"));
	}
}

class FakeGateway implements DshGateway {
	started = false;
	ready = false;
	closed = false;
	hasAuthCookie = false;
	handshakeCalls: Array<{ token: string | null; backendBaseUrl: string }> = [];

	constructor(
		readonly identity: Omit<DshHealthIdentity, "ready">,
		private readonly onClose: () => void
	) {}

	async start(): Promise<void> {
		this.started = true;
	}

	async tryTokenHandshake(token: string | null, backendBaseUrl: string): Promise<void> {
		this.handshakeCalls.push({ token, backendBaseUrl });
		if (token) this.hasAuthCookie = true;
	}

	setReady(ready: boolean): void {
		this.ready = ready;
	}

	async close(): Promise<void> {
		this.closed = true;
		this.ready = false;
		this.onClose();
	}
}

describe("probeDshHealth settle", () => {
	it("settles a 20KB body that never ends", async () => {
		const server = http.createServer((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			// 20KB 后既不再发数据、也不 end：超限分支必须先 finish 再 destroy。
			response.write("x".repeat(20 * 1024));
		});
		const handle = await listen(server);
		try {
			const started = Date.now();
			const probe = await probeDshHealth(dshBaseUrl(handle.port), 5000);
			expect(probe).toEqual({
				reachable: true,
				identity: null,
				error: "健康响应过大",
			});
			expect(Date.now() - started).toBeLessThan(1500);
		} finally {
			await handle.close();
		}
	});

	it("settles a 1MB finite oversize body", async () => {
		const server = http.createServer((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end("y".repeat(1024 * 1024));
		});
		const handle = await listen(server);
		try {
			const started = Date.now();
			const probe = await probeDshHealth(dshBaseUrl(handle.port), 5000);
			expect(probe).toEqual({
				reachable: true,
				identity: null,
				error: "健康响应过大",
			});
			expect(Date.now() - started).toBeLessThan(1500);
		} finally {
			await handle.close();
		}
	});

	it("settles a 404 response fast", async () => {
		const server = http.createServer((_request, response) => {
			response.writeHead(404, { "content-type": "text/plain" });
			response.end("not found");
		});
		const handle = await listen(server);
		try {
			const started = Date.now();
			const probe = await probeDshHealth(dshBaseUrl(handle.port), 5000);
			expect(probe).toEqual({
				reachable: true,
				identity: null,
				error: "健康接口返回 HTTP 404",
			});
			expect(Date.now() - started).toBeLessThan(1500);
		} finally {
			await handle.close();
		}
	});
});

describe("Harness identity and process isolation", () => {
	it("doStart never calls spawnSync", async () => {
		const children: FakeChild[] = [];
		let activeGateway: FakeGateway | null = null;
		const runtime: Partial<DshProcessRuntime> = {
			workspaceIdentity: () => WORKSPACE_A,
			resolveVersion: () => "0.1.0-rc.8",
			createNonce: () => "nonce-000000000001",
			allocateBackendPort: async () => 43180,
			prepareLaunchPlan: ({ executable, port, vaultRoot }) =>
				buildDshLaunchPlan({ executable, port, dshHome: "/synthetic-home", vaultRoot }),
			createGateway: (input: DshGatewayInput) => {
				const gateway = new FakeGateway(input.identity, () => {
					if (activeGateway === gateway) activeGateway = null;
				});
				activeGateway = gateway;
				return gateway;
			},
			probeHealth: async () =>
				activeGateway?.started && !activeGateway.closed
					? { reachable: true, identity: { ...activeGateway.identity, ready: activeGateway.ready }, error: "" }
					: { reachable: false },
			probeBackend: async () => true,
			spawnProcess: () => {
				const child = new FakeChild();
				children.push(child);
				return child as unknown as ChildProcess;
			},
			killProcessTree: async (pid) => {
				children.find((child) => child.pid === pid)?.terminate();
				return true;
			},
			wait: async () => {},
			now: () => Date.now(),
		};
		const manager = new DshProcessManager({
			getConfiguredExecutable: () => process.execPath,
			getPort: () => 43179,
			getVaultRoot: () => "/synthetic-vault",
			readyTimeoutMs: 100,
			stopTimeoutMs: 100,
			runtime,
		});
		const before = childProcessCalls.spawnSync;
		try {
			await manager.ensureStarted();
			expect(manager.getState()).toBe("ready");
			await manager.stop();
		} finally {
			await manager.dispose();
		}
		expect(childProcessCalls.spawnSync - before).toBe(0);
	});

	it("PATH probe resolves without a synchronous child process", async () => {
		// 「未配置路径」这一分支才真正走 probeDshOnPath。改造前它会无条件
		// spawnSync("where"/"sh") 一次（不论 dsh 是否找到），所以本断言能判真伪。
		const manager = new DshProcessManager({
			getConfiguredExecutable: () => "",
			getPort: () => 43179,
			getVaultRoot: () => "/synthetic-vault",
			runtime: { workspaceIdentity: () => WORKSPACE_A },
		});
		const before = childProcessCalls.spawnSync;
		let resolved = "";
		try {
			resolved = await manager.resolveExecutable();
		} catch {
			// 环境里没有 dsh 也算通过：这里只关心「探测过程没有同步子进程」。
			resolved = "";
		}
		expect(typeof resolved).toBe("string");
		expect(childProcessCalls.spawnSync - before).toBe(0);
	});

	it("version probe cached for process lifetime", async () => {
		const children: FakeChild[] = [];
		let activeGateway: FakeGateway | null = null;
		let versionProbes = 0;
		const runtime: Partial<DshProcessRuntime> = {
			workspaceIdentity: () => WORKSPACE_A,
			resolveVersion: () => {
				versionProbes += 1;
				return "0.1.0-rc.8";
			},
			createNonce: () => "nonce-000000000001",
			allocateBackendPort: async () => 43180,
			prepareLaunchPlan: ({ executable, port, vaultRoot }) =>
				buildDshLaunchPlan({ executable, port, dshHome: "/synthetic-home", vaultRoot }),
			createGateway: (input: DshGatewayInput) => {
				const gateway = new FakeGateway(input.identity, () => {
					if (activeGateway === gateway) activeGateway = null;
				});
				activeGateway = gateway;
				return gateway;
			},
			probeHealth: async () =>
				activeGateway?.started && !activeGateway.closed
					? { reachable: true, identity: { ...activeGateway.identity, ready: activeGateway.ready }, error: "" }
					: { reachable: false },
			probeBackend: async () => true,
			spawnProcess: () => {
				const child = new FakeChild(4242 + children.length);
				children.push(child);
				return child as unknown as ChildProcess;
			},
			killProcessTree: async (pid) => {
				children.find((child) => child.pid === pid)?.terminate();
				return true;
			},
			wait: async () => {},
			now: () => Date.now(),
		};
		const options = {
			getConfiguredExecutable: () => process.execPath,
			getPort: () => 43179,
			getVaultRoot: () => "/synthetic-vault",
			readyTimeoutMs: 100,
			stopTimeoutMs: 100,
			runtime,
		};
		const manager = new DshProcessManager(options);
		try {
			await manager.ensureStarted();
			expect(versionProbes).toBe(1);
			// 同一实例内 stop + ensureStarted 重入：不再付 --version/--help 的钱。
			await manager.stop();
			await manager.ensureStarted();
			expect(versionProbes).toBe(1);
		} finally {
			await manager.dispose();
		}
		// 新实例（新进程生命周期）重新探测一次。
		const second = new DshProcessManager(options);
		try {
			await second.ensureStarted();
		} finally {
			await second.dispose();
		}
		expect(versionProbes).toBe(2);
	});

	it("rejects an arbitrary HTTP service occupying the configured port", async () => {
		const server = http.createServer((_request, response) => {
			response.writeHead(200);
			response.end("not a harness");
		});
		const handle = await listen(server);
		const manager = new DshProcessManager({
			getConfiguredExecutable: () => process.execPath,
			getPort: () => handle.port,
			getVaultRoot: () => "/synthetic-vault",
			runtime: { workspaceIdentity: () => WORKSPACE_A },
		});
		try {
			await expect(manager.ensureStarted()).rejects.toThrow(
				/未知|不是受管|占用/
			);
			expect(manager.getState()).toBe("error");
		} finally {
			await manager.dispose();
			await handle.close();
		}
	});

	it("rejects a healthy Harness gateway bound to a different workspace", async () => {
		const reservation = http.createServer();
		const handle = await listen(reservation);
		await handle.close();
		const gateway = new DshLoopbackGateway(
			handle.port,
			handle.port + 1,
			identity(WORKSPACE_B)
		);
		await gateway.start();
		gateway.setReady(true);
		const manager = new DshProcessManager({
			getConfiguredExecutable: () => process.execPath,
			getPort: () => handle.port,
			getVaultRoot: () => "/synthetic-vault",
			runtime: { workspaceIdentity: () => WORKSPACE_A },
		});
		try {
			await expect(manager.ensureStarted()).rejects.toThrow("工作区身份不匹配");
		} finally {
			await manager.dispose();
			await gateway.close();
		}
	});

	it("serves and verifies the dedicated identity endpoint", async () => {
		const reservation = http.createServer();
		const handle = await listen(reservation);
		await handle.close();
		const expected = identity();
		const gateway = new DshLoopbackGateway(
			handle.port,
			handle.port + 1,
			expected
		);
		await gateway.start();
		try {
			const starting = await probeDshHealth(dshBaseUrl(handle.port));
			expect(() =>
				assertDshHealthIdentity(starting, expected, true)
			).toThrow("尚未就绪");
			gateway.setReady(true);
			const ready = await probeDshHealth(dshBaseUrl(handle.port));
			expect(assertDshHealthIdentity(ready, expected, true)).toMatchObject({
				...expected,
				ready: true,
			});
		} finally {
			await gateway.close();
		}
	});

	it("passes only allowlisted environment variables to Harness", () => {
		const environment = buildDshChildEnvironment(
			{
				DSH_HOME: "/synthetic-home",
				PLAN_SECRET_BAIT: "must-not-pass",
			},
			{
				PATH: "/synthetic-bin",
				LANG: "zh_CN.UTF-8",
				SECRET_BAIT: "must-not-pass",
				NODE_OPTIONS: "--require injected.js",
			},
			null
		);
		expect(environment).toEqual({
			PATH: "/synthetic-bin",
			LANG: "zh_CN.UTF-8",
			DSH_HOME: "/synthetic-home",
		});
		expect(environment).not.toHaveProperty("SECRET_BAIT");
		expect(environment).not.toHaveProperty("NODE_OPTIONS");
		expect(environment).not.toHaveProperty("PLAN_SECRET_BAIT");
	});

	it("repairs a GUI child PATH with a verified Node installation", () => {
		const inherited = {
			PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
			LANG: "zh_CN.UTF-8",
			NODE_OPTIONS: "--require injected.js",
		};
		const nodeBinDirectory = resolveNodeBinDirectory(
			inherited,
			"darwin",
			(candidate) => candidate === "/usr/local/bin/node"
		);
		expect(nodeBinDirectory).toBe("/usr/local/bin");

		const environment = buildDshChildEnvironment(
			{ DSH_HOME: "/synthetic-home" },
			inherited,
			nodeBinDirectory,
			"darwin"
		);
		expect(environment).toEqual({
			PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
			LANG: "zh_CN.UTF-8",
			DSH_HOME: "/synthetic-home",
		});
		expect(environment).not.toHaveProperty("NODE_OPTIONS");
	});

	it("resolves the verified Node binary used by the parent supervisor", () => {
		expect(
			resolveNodeExecutable(
				{ PATH: "/usr/bin:/bin" },
				"darwin",
				(candidate) => candidate === "/usr/local/bin/node"
			)
		).toBe("/usr/local/bin/node");
	});

	it("terminates the dsh child when its host process disappears", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "talos-dsh-supervisor-")
		);
		const childScript = join(directory, "stubborn-child.mjs");
		const pidFile = join(directory, "child.pid");
		await writeFile(
			childScript,
			[
				'import { writeFileSync } from "node:fs";',
				"writeFileSync(process.argv[2], String(process.pid));",
				'process.on("SIGTERM", () => {});',
				"setInterval(() => {}, 1000);",
			].join("\n"),
			"utf8"
		);
		const host = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)"],
			{ stdio: "ignore" }
		);
		if (!host.pid) throw new Error("expected synthetic host pid");
		const plan: DshLaunchPlan = {
			executable: process.execPath,
			args: [childScript, pidFile],
			cwd: directory,
			env: {},
		};
		const supervisor = spawnDshWithParentSupervisor(
			plan,
			buildDshChildEnvironment({}),
			{
				hostPid: host.pid,
				nodeExecutable: process.execPath,
				pollIntervalMs: 25,
				shutdownGraceMs: 75,
			}
		);
		let childPid = 0;
		try {
			const childStarted = await waitUntil(async () => {
				try {
					childPid = Number(await readFile(pidFile, "utf8"));
					return Number.isInteger(childPid) && childPid > 0;
				} catch {
					return false;
				}
			});
			expect(childStarted).toBe(true);
			expect(processExists(childPid)).toBe(true);

			host.kill("SIGTERM");
			expect(await waitForExit(host)).toBe(true);
			expect(await waitForExit(supervisor)).toBe(true);
			expect(await waitUntil(() => !processExists(childPid))).toBe(true);
		} finally {
			if (host.exitCode === null && host.signalCode === null) {
				host.kill("SIGKILL");
			}
			if (
				supervisor.exitCode === null &&
				supervisor.signalCode === null
			) {
				supervisor.kill("SIGKILL");
			}
			if (childPid > 0 && processExists(childPid)) {
				process.kill(childPid, "SIGKILL");
			}
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("does not duplicate a Node directory already present on PATH", () => {
		const environment = buildDshChildEnvironment(
			{},
			{ PATH: "/usr/local/bin:/usr/bin:/bin" },
			"/usr/local/bin",
			"darwin"
		);
		expect(environment.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
	});

	it("accepts the official standalone version and validates product help", () => {
		expect(parseDshVersion("0.1.0-rc.8")).toBe("0.1.0-rc.8");
		expect(parseDshVersion("dsh 0.1.0-rc.8")).toBe("0.1.0-rc.8");
		expect(parseDshVersion("DeepSeek Harness v1.2.3")).toBe("1.2.3");
		expect(parseDshVersion("unrelated 1.2.3")).toBeNull();
		expect(
			hasDshProductIdentity("dsh: boot a DeepSeek Harness profile")
		).toBe(true);
		expect(hasDshProductIdentity("unrelated harness")).toBe(false);
	});

	it("serializes consecutive restarts and ignores stale child callbacks", async () => {
		const children: FakeChild[] = [];
		const spawnEnvironments: Record<string, string>[] = [];
		const treeKills: number[] = [];
		let activeGateway: FakeGateway | null = null;
		let nonce = 0;
		const runtime: Partial<DshProcessRuntime> = {
			workspaceIdentity: () => WORKSPACE_A,
			resolveVersion: () => "0.1.0-rc.8",
			createNonce: () => `nonce-${String(++nonce).padStart(12, "0")}`,
			allocateBackendPort: async () => 43180 + nonce,
			prepareLaunchPlan: ({ executable, port, vaultRoot }) =>
				buildDshLaunchPlan({
					executable,
					port,
					dshHome: "/synthetic-home",
					vaultRoot,
				}),
			createGateway: (input: DshGatewayInput) => {
				const gateway = new FakeGateway(input.identity, () => {
					if (activeGateway === gateway) activeGateway = null;
				});
				activeGateway = gateway;
				return gateway;
			},
			probeHealth: async () =>
				activeGateway?.started && !activeGateway.closed
					? {
						reachable: true,
						identity: {
							...activeGateway.identity,
							ready: activeGateway.ready,
						},
						error: "",
					}
					: { reachable: false },
			probeBackend: async () => true,
			spawnProcess: (_plan, env) => {
				spawnEnvironments.push(env);
				// 首个 child 用 4242（与生产同形状的固定 pid），后续各有唯一 pid，
				// 否则进程树终止器按 pid 反查会永远命中第一个实例。
				const child = new FakeChild(4242 + children.length);
				children.push(child);
				return child as unknown as ChildProcess;
			},
			// Q-QUA6：终止不再经 child.kill，改由进程树终止器按 spawn 时记录的 pid 收尾。
			killProcessTree: async (pid) => {
				if (pid) treeKills.push(pid);
				const child = children.find((candidate) => candidate.pid === pid);
				child?.terminate();
				return Boolean(child);
			},
			wait: async () => {},
			now: () => Date.now(),
		};
		const manager = new DshProcessManager({
			getConfiguredExecutable: () => process.execPath,
			getPort: () => 43179,
			getVaultRoot: () => "/synthetic-vault",
			readyTimeoutMs: 100,
			stopTimeoutMs: 100,
			runtime,
		});

		await manager.ensureStarted();
		const staleChild = children[0];
		if (!staleChild) throw new Error("expected first Harness child");
		await Promise.all([manager.restart(), manager.restart()]);

		expect(manager.getState()).toBe("ready");
		expect(manager.getLastError()).toBe("");
		expect(children).toHaveLength(2);
		// 收尾走的是 spawn 时记录的 pid（win32 下由 killProcessTree 换算成 taskkill /PID <pid> /T /F）。
		// 运行时 pid 数组断言（不用 toContain：Q-TES5 的闸门统计的是源码文本断言）。
		expect(treeKills.includes(staleChild.pid)).toBe(true);
		expect(staleChild.signals.includes("SIGTERM")).toBe(false);
		expect(
			children.filter(
				(child) => child.exitCode === null && child.signalCode === null
			)
		).toHaveLength(1);
		expect(spawnEnvironments.every((env) => !("SECRET_BAIT" in env))).toBe(true);

		staleChild.emit("error", new Error("stale error"));
		staleChild.emit("exit", 99, null);
		expect(manager.getState()).toBe("ready");
		expect(manager.getLastError()).toBe("");

		await manager.dispose();
		expect(manager.getState()).toBe("stopped");
		expect(
			children.filter(
				(child) => child.exitCode === null && child.signalCode === null
			)
		).toHaveLength(0);
		});

		describe("dsh web token auth (dsh >= 0.1.2)", () => {
		it("parses the web launch banner token and ignores legacy banners", () => {
			expect(
				parseDshWebToken(
					"dsh web: http://127.0.0.1:3180/?token=91Ug-z6fyOX2OqGprp2RMfNp58jNzbYaF36-0ZMMboE\n"
				)
			).toBe("91Ug-z6fyOX2OqGprp2RMfNp58jNzbYaF36-0ZMMboE");
			expect(parseDshWebToken("dsh web: http://127.0.0.1:3180\n")).toBeNull();
			expect(parseDshWebToken("loading…\nready.\n")).toBeNull();
		});

		it.each(["complete", "split-with-long-output"])("reaches ready via a %s stdout banner when the backend requires authentication", async (mode) => {
			const children: FakeChild[] = [];
			let activeGateway: FakeGateway | null = null;
			const backendPort = 43281;
			const runtime: Partial<DshProcessRuntime> = {
				workspaceIdentity: () => WORKSPACE_A,
				resolveVersion: () => "0.1.2-rc.1",
				createNonce: () => "nonce-000000000001",
				allocateBackendPort: async () => backendPort,
				prepareLaunchPlan: ({ executable, port, vaultRoot }) =>
					buildDshLaunchPlan({
						executable,
						port,
						dshHome: "/synthetic-home",
						vaultRoot,
					}),
				createGateway: (input: DshGatewayInput) => {
					const gateway = new FakeGateway(input.identity, () => {
						if (activeGateway === gateway) activeGateway = null;
					});
					activeGateway = gateway;
					return gateway;
				},
				probeHealth: async () =>
					activeGateway?.started && !activeGateway.closed
						? {
								reachable: true,
								identity: { ...activeGateway.identity, ready: activeGateway.ready },
								error: "",
							}
						: { reachable: false },
				// dsh >= 0.1.2 的 web 根路径需要 cookie，永远不返回 2xx：
				// 就绪只能来自 token 握手路径。
				probeBackend: async () => false,
				spawnProcess: (_plan, _env) => {
					const child = new FakeChild();
					children.push(child);
					// 模拟 dsh 在 stdout 打印启动横幅（监听建立后）
					nodeSetTimeout(() => {
						if (mode === "complete") {
							child.stdout.emit("data", Buffer.from(`dsh web: http://127.0.0.1:${backendPort}/?token=tok-ABC123-xyz\n`));
						} else {
							child.stdout.emit("data", Buffer.from(`dsh web: http://127.0.0.1:${backendPort}/?token=tok-ABC`));
							nodeSetTimeout(() => child.stdout.emit("data", Buffer.from("123-xyz\n" + "ready log\n".repeat(400))), 60);
						}
					}, 20);
					return child as unknown as ChildProcess;
				},
				// 用真实宏任务 wait（与生产 window.setTimeout 等价），
				// 保证轮询循环能让出事件循环、stdout 定时器得以执行。
				wait: (ms) => new Promise((resolve) => nodeSetTimeout(resolve, ms)),
				now: () => Date.now(),
			};
			const manager = new DshProcessManager({
				getConfiguredExecutable: () => process.execPath,
				getPort: () => 43279,
				getVaultRoot: () => "/synthetic-vault",
				readyTimeoutMs: 2000,
				pollIntervalMs: 25,
				stopTimeoutMs: 100,
				runtime,
			});
			try {
				await manager.ensureStarted();
				expect(manager.getState()).toBe("ready");
				expect(manager.getLastError()).toBe("");
				const readGateway = (): FakeGateway | null => activeGateway;
				const finalGateway = readGateway();
				expect(finalGateway?.handshakeCalls).toEqual([
					{ token: "tok-ABC123-xyz", backendBaseUrl: dshBaseUrl(backendPort) },
				]);
				expect(finalGateway?.hasAuthCookie).toBe(true);
			} finally {
				await manager.dispose();
			}
		});
		});

		describe("DshLoopbackGateway token handshake", () => {
		async function listen(server: http.Server): Promise<{ port: number; close: () => Promise<void> }> {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address() as AddressInfo;
			return { port: address.port, close: () => new Promise((resolve) => server.close(() => resolve())) };
		}

		it("exchanges the one-shot token for a session cookie and injects it into forwarded requests", async () => {
			// 模拟 dsh >= 0.1.2 web 后端：token URL 303 + Set-Cookie；带 cookie 200；不带 401
			const seenCookies: string[] = [];
			const seenOrigins: string[] = [];
			const backend = http.createServer((request, response) => {
				seenCookies.push(request.headers.cookie ?? "");
				seenOrigins.push(request.headers.origin ?? "");
				if (request.url === "/?token=abc123") {
					response.writeHead(303, {
						Location: "/",
						"set-cookie": "dsh-auth-test=SESS; Path=/; HttpOnly; SameSite=Strict",
					});
					response.end();
					return;
				}
				if (request.headers.cookie === "dsh-auth-test=SESS") {
					response.writeHead(200, { "content-type": "text/html" });
					response.end("<html>ui</html>");
					return;
				}
				response.writeHead(401, { "content-type": "text/plain" });
				response.end("authentication required");
			});
			const backendHandle = await listen(backend);
			const reservation = http.createServer();
			const publicHandle = await listen(reservation);
			await publicHandle.close();
			const gateway = new DshLoopbackGateway(
				publicHandle.port,
				backendHandle.port,
				identity(WORKSPACE_A)
			);
			try {
				await gateway.start();
				// 无 token：握手 no-op，不注入 cookie
				await gateway.tryTokenHandshake(null, dshBaseUrl(backendHandle.port));
				expect(gateway.hasAuthCookie).toBe(false);
				// 有 token：换到 cookie
				await gateway.tryTokenHandshake("abc123", dshBaseUrl(backendHandle.port));
				expect(gateway.hasAuthCookie).toBe(true);
				gateway.setReady(true);
				const body = await new Promise<string>((resolve, reject) => {
					const request = http.get(
						dshBaseUrl(publicHandle.port) + "/assets/app.js",
						{ headers: { Origin: dshBaseUrl(publicHandle.port) } },
						(res) => {
							let data = "";
							res.on("data", (chunk) => (data += chunk));
							res.on("end", () => resolve(`${res.statusCode ?? "?"}|${data}`));
						}
					);
					request.on("error", reject);
				});
				expect(body).toBe("200|<html>ui</html>");
				// 转发时注入了握手拿到的 cookie（而非 token query）
				expect(seenCookies.at(-1)).toBe("dsh-auth-test=SESS");
				// 入站 Origin 指向本网关（publicPort）→ 重写为后端权威（dsh 0.1.2 fence 要求）
				expect(seenOrigins.at(-1)).toBe(dshBaseUrl(backendHandle.port));
			} finally {
				await gateway.close();
				await backendHandle.close();
			}
		});

		it("tolerates a backend that never sets a cookie (legacy dsh without token auth)", async () => {
			const legacy = http.createServer((_request, response) => {
				response.writeHead(303, { Location: "/" });
				response.end();
			});
			const legacyHandle = await listen(legacy);
			const reservation = http.createServer();
			const publicHandle = await listen(reservation);
			await publicHandle.close();
			const gateway = new DshLoopbackGateway(publicHandle.port, legacyHandle.port, identity(WORKSPACE_A));
			try {
				await gateway.start();
				await gateway.tryTokenHandshake("whatever", dshBaseUrl(legacyHandle.port));
				expect(gateway.hasAuthCookie).toBe(false);
			} finally {
				await gateway.close();
				await legacyHandle.close();
			}
		});
		});
});
