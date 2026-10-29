import { describe, expect, it } from "vitest";
import { validateProviderProfile, type ProviderProfile } from "../src/agent-workbench/contracts/provider-profile";
import { validateCustomApi } from "../src/agent-workbench/config/custom-api";
import { validateRealtimeEndpoint } from "../src/quyuan/realtime-provider";
import { WorkbenchSettingsStore } from "../src/agent-workbench/storage/workbench-settings-store";

/**
 * Q-SEC7：端点策略的三条路径共用同一个断言。
 *
 * 改动前实测（方案记录、本轮复现一致）：`validateProviderProfile` 只判
 * `protocol !== "https:" && !loopback`，等价于「任意 scheme + loopback 都放行」，
 * 且完全不拒 userinfo——`ftp://127.0.0.1/x`、`file://127.0.0.1/etc/passwd`、
 * `gopher://localhost:70/x`、`https://user:pw@api.example.com` 全部 ACCEPTED，
 * 只有 `http://evil.example.com` 被拒。同一批输入 `validateRealtimeEndpoint`
 * 拒了 userinfo 与明文 http，两处已经分叉。
 */

function profile(endpoint: string): ProviderProfile {
	return {
		id: "policy-probe",
		displayName: "Policy Probe",
		runtimeId: "ohmypi",
		protocol: "openai-chat",
		endpoint,
		models: ["model-x"],
		enabled: true,
	};
}

/** 三条路径各跑一次，返回「是否接受」。 */
function acceptsProfile(endpoint: string): boolean {
	try {
		validateProviderProfile(profile(endpoint));
		return true;
	} catch {
		return false;
	}
}

function acceptsRealtime(endpoint: string): boolean {
	try {
		validateRealtimeEndpoint(endpoint);
		return true;
	} catch {
		return false;
	}
}

function acceptsCustomApi(endpoint: string): boolean {
	const draft = { kind: "anthropic" as const, baseUrl: endpoint, models: ["glm-5.3"], apiKey: "k" };
	return validateCustomApi(draft, false) === null;
}

describe("endpoint policy: arbitrary scheme + loopback", () => {
	// 这 3 条在本轮是**新增能力**：改动前 profile 与 realtime 两条路径都放行（custom-api 已拒）。
	const cases = [
		["ftp", "ftp://127.0.0.1/x"],
		["file", "file://127.0.0.1/etc/passwd"],
		["gopher", "gopher://localhost:70/x"],
	] as const;

	it.each(cases)("rejects %s:// against both the profile and the realtime path", (_scheme, endpoint) => {
		expect(acceptsProfile(endpoint)).toBe(false);
		expect(acceptsRealtime(endpoint)).toBe(false);
	});

	// custom-api 现状即是拒绝（不回归）：它没有为这三条新增能力，只用于确认收严没有把它改坏。
	it.each(cases)("keeps custom-api rejections for %s:// unchanged", (_scheme, endpoint) => {
		expect(acceptsCustomApi(endpoint)).toBe(false);
		expect(validateCustomApi({ kind: "anthropic", baseUrl: endpoint, models: ["m"], apiKey: "k" }, false))
			.toMatch(/HTTPS/);
	});
});

describe("endpoint policy: userinfo", () => {
	it("rejects embedded credentials on all three paths", () => {
		const withPassword = "https://user:pw@api.example.com";
		expect(acceptsProfile(withPassword)).toBe(false);
		expect(acceptsRealtime(withPassword)).toBe(false);
		// custom-api 保留自己的字面文案（tests/custom-api.test.ts:60 断言含「账号」）。
		expect(validateCustomApi({ kind: "anthropic", baseUrl: withPassword, models: ["m"], apiKey: "k" }, false))
			.toMatch(/账号/);
	});

	it("rejects a username without a password too", () => {
		const userOnly = "https://user@api.example.com";
		expect(acceptsProfile(userOnly)).toBe(false);
		expect(acceptsRealtime(userOnly)).toBe(false);
		expect(validateCustomApi({ kind: "anthropic", baseUrl: userOnly, models: ["m"], apiKey: "k" }, false))
			.toMatch(/账号/);
	});

	it("collects the userinfo check in exactly one place", async () => {
		// 判定收敛的静态证据：唯一直接读 url.username 的地方是 assertAllowedEndpoint。
		const fs = await import("node:fs");
		const path = await import("node:path");
		const url = await import("node:url");
		const root = url.fileURLToPath(new URL("../", import.meta.url));
		const files = [
			"src/agent-workbench/contracts/provider-profile.ts",
			"src/quyuan/realtime-provider.ts",
			"src/agent-workbench/config/custom-api.ts",
		];
		const hits = files.flatMap((file) =>
			fs.readFileSync(path.join(root, file), "utf8").split("\n")
				.map((line, index) => ({ file, line: line.trim(), number: index + 1 }))
				.filter((entry) => entry.line.includes("url.username"))
		);
		expect(hits.map((hit) => hit.file)).toEqual(["src/agent-workbench/contracts/provider-profile.ts"]);
	});
});

describe("endpoint policy: legal endpoints and existing normalisation", () => {
	it("accepts https on all three paths", () => {
		expect(acceptsProfile("https://api.example.com")).toBe(true);
		expect(acceptsRealtime("https://api.example.com")).toBe(true);
		expect(acceptsCustomApi("https://api.example.com")).toBe(true);
	});

	it.each([
		"http://localhost:8080/x",
		"http://127.0.0.1:8080/x",
		"http://[::1]:8080/x",
	])("accepts http loopback %s on all three paths", (endpoint) => {
		expect(acceptsProfile(endpoint)).toBe(true);
		expect(acceptsRealtime(endpoint)).toBe(true);
		expect(acceptsCustomApi(endpoint)).toBe(true);
	});

	it("keeps the profile normalisation (host lowercased, trailing slash dropped)", () => {
		expect(validateProviderProfile(profile("https://API.Example.TEST/")).endpoint)
			.toBe("https://api.example.test");
	});

	it("keeps the realtime trailing-slash contract used by /sessions concatenation", () => {
		// src/plugin/quyuan-voice-tools.ts:226 拿这个返回值拼 "/sessions"。
		expect(validateRealtimeEndpoint("https://api.example.test")).toBe("https://api.example.test/");
		expect(validateRealtimeEndpoint("https://api.x/v1/realtime/")).toBe("https://api.x/v1/realtime");
	});

	it("still rejects plain http to a non-loopback host", () => {
		expect(acceptsProfile("http://evil.example.com")).toBe(false);
		expect(acceptsRealtime("http://evil.example.com")).toBe(false);
		expect(acceptsCustomApi("http://evil.example.com")).toBe(false);
	});

	it("no longer produces the IPv6 loopback false negative", () => {
		// 白名单写裸 "::1" 而 URL.hostname 对 IPv6 带方括号，二者永不相等。
		// 断言值以真实 URL 解析为准，不按规则推断。
		expect(new URL("http://[::1]:8080/x").hostname).toBe("[::1]");
		expect(acceptsProfile("http://[::1]:8080/x")).toBe(true);
		expect(acceptsRealtime("http://[::1]:8080/x")).toBe(true);
	});
});

describe("endpoint policy: invalid profiles are kept and marked, not silently dropped", () => {
	function store(raw: unknown) {
		return new WorkbenchSettingsStore(
			{ read: async () => raw, write: async () => undefined },
			{ has: () => true },
		);
	}

	const rawSettings = {
		schemaVersion: 1,
		runtimes: [],
		providers: [
			{
				id: "https-ok", displayName: "OK", runtimeId: "ohmypi", protocol: "openai-chat",
				endpoint: "https://api.example.test/v1", models: ["m1"], enabled: true,
			},
			{
				id: "ftp-loopback", displayName: "FTP", runtimeId: "ohmypi", protocol: "openai-chat",
				endpoint: "ftp://127.0.0.1/x", models: ["m2"], enabled: true,
			},
			{
				id: "http-remote", displayName: "Remote", runtimeId: "ohmypi", protocol: "openai-chat",
				endpoint: "http://evil.example.com", models: ["m3"], enabled: true,
			},
		],
		selection: { runtimeId: "ohmypi", providerProfileId: "https-ok", model: "m1" },
		workflow: "plan",
		permission: "ask",
	};

	it("keeps the rejected profile in the list and marks it invalid", async () => {
		const loaded = await store(rawSettings).load();
		// ① 不再无声消失：条数不下降（改动前实测 3 → 2，ftp 存留、http 被静默丢弃；
		//    现在两条非法 profile 都保留）。
		expect(loaded.providers.map((item) => item.id)).toEqual(["https-ok", "ftp-loopback", "http-remote"]);
		// ② 带显式的无效标记（原因文案来自统一的判定函数）。
		const ftp = loaded.providers.find((item) => item.id === "ftp-loopback");
		expect(ftp?.invalidReason).toMatch(/HTTPS/);
		expect(ftp?.enabled).toBe(false);
		const remote = loaded.providers.find((item) => item.id === "http-remote");
		expect(remote?.invalidReason).toMatch(/HTTPS/);
		expect(remote?.enabled).toBe(false);
		// ③ 合法 https profile 仍在且未被标记。
		const ok = loaded.providers.find((item) => item.id === "https-ok");
		expect(ok).toBeDefined();
		expect(ok?.invalidReason).toBeUndefined();
	});

	it("does not let a kept-but-invalid profile become selectable", async () => {
		const loaded = await store(rawSettings).load();
		// selection 若指向非法 profile，必须被清掉而不是指向一个发不出请求的 provider。
		const selectingInvalid = await store({
			...rawSettings,
			selection: { runtimeId: "ohmypi", providerProfileId: "ftp-loopback", model: "m2" },
		}).load();
		expect(loaded.selection.providerProfileId).toBe("https-ok");
		expect(selectingInvalid.selection).toEqual({ runtimeId: "ohmypi" });
	});

	it("lets an unrelated save succeed despite a kept-but-invalid profile", async () => {
		// 「保留但标无效」的副作用必须一起兜住：save() 若对标注无效的条目再校验一次，
		// 用户只改 workflow/permission 就会因为一条读不出来的历史 profile 而整体落盘失败，
		// 等于把「无声消失」换成了「无声不可保存」。
		const written: Array<{ id: string; invalidReason?: string }> = [];
		let savedPermission = "";
		const roundTrip = new WorkbenchSettingsStore(
			{
				read: async () => rawSettings,
				write: async (value) => {
					written.push(...value.providers);
					savedPermission = value.permission;
				},
			},
			{ has: () => true },
		);
		const loaded = await roundTrip.load();
		await roundTrip.save({ ...loaded, permission: "scoped" });
		expect(savedPermission).toBe("scoped");
		// 非法条目原样带 invalidReason 写回，没有被剔除、也没有被「洗白」。
		expect(written.map((item) => item.id)).toEqual(["https-ok", "ftp-loopback", "http-remote"]);
		expect(Boolean(written.find((item) => item.id === "ftp-loopback")?.invalidReason)).toBe(true);
	});
});
