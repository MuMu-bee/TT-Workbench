import { describe, expect, it } from "vitest";
import { sanitizeAuditValue } from "../src/task-core/audit-sanitizer";

describe("sanitizeAuditValue", () => {
	it("redacts credential fields and secret-looking strings recursively", () => {
		const githubTokenPrefix = ["gh", "p_"].join("");
		const fakeGithubToken = [
			githubTokenPrefix,
			"abcdefghijklmnopqrstuvwxyz123456",
		].join("");
		const sanitized = sanitizeAuditValue({
			provider: "claude",
			headers: {
				Authorization: "Bearer fake-secret-token",
				"x-api-key": "sk-ant-api03-fake-secret-value",
			},
			nested: [
				{ cookie: "session=fake-cookie" },
				`token=${fakeGithubToken}`,
			],
		});
		const text = JSON.stringify(sanitized);

		expect(text).toContain("[REDACTED]");
		expect(text).not.toContain("fake-secret");
		expect(text).not.toContain("fake-cookie");
		expect(text).not.toContain(githubTokenPrefix);
	});

	it("masks absolute home paths but preserves Vault-relative paths", () => {
		const fakeHomePath = [
			"",
			"Users",
			"example",
			"Documents",
			"private.md",
		].join("/");
		const sanitized = sanitizeAuditValue({
			absolute: fakeHomePath,
			relative: "30 洞察/主题.md",
		});

		expect(sanitized).toEqual({
			absolute: "[HOME_PATH]",
			relative: "30 洞察/主题.md",
		});
	});

	it("redacts complete Unix and Windows home paths embedded in messages", () => {
		const unixHomePath = [
			"",
			"Users",
			"example",
			"Documents",
			"private.md",
		].join("/");
		const windowsHomePath = [
			"C:",
			"Users",
			"example",
			"Documents",
			"private.md",
		].join("\\");
		const sanitized = sanitizeAuditValue(
			`Read failed at "${unixHomePath}": copied from ${windowsHomePath}. Denied!`
		);

		expect(sanitized).toBe(
			'Read failed at "[HOME_PATH]": copied from [HOME_PATH]. Denied!'
		);
		expect(sanitized).not.toContain("example");
		expect(sanitized).not.toContain("private.md");
	});

	it("redacts URL userinfo but keeps scheme and host", () => {
		const clone =
			"git clone https://oauth2:ghp_abcdefghijklmnopqrstuvwx@github.com/x/y.git";

		expect(sanitizeAuditValue(clone)).toBe(
			"git clone https://[REDACTED]@github.com/x/y.git"
		);
	});

	it("redacts CLI passwords for password-reading clients only", () => {
		expect(sanitizeAuditValue("mysql -pS3cr3tPassw0rd -u root")).toBe(
			"mysql -p[REDACTED] -u root"
		);
		// 端口启发式会误伤这两条：它们必须完全不变
		expect(sanitizeAuditValue("docker run -p8080:80 nginx")).toBe(
			"docker run -p8080:80 nginx"
		);
		expect(sanitizeAuditValue("ssh -p22 deploy@host")).toBe(
			"ssh -p22 deploy@host"
		);
	});

	it("keeps the existing uppercase KEY=value behaviour and ignores port-like args", () => {
		// 既有 `(?:token|api[-_]?key)\s*=\s*\S+` 已覆盖该形态，本条只固化行为
		expect(sanitizeAuditValue("OPENAI_API_KEY=abcdefghijklmnop")).toBe(
			"OPENAI_[REDACTED]"
		);
		expect(sanitizeAuditValue("max_tokens=8192")).toBe("max_tokens=8192");
	});
});
