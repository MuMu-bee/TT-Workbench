export type SecretBlockReason =
	| "unsafe-path"
	| "unclassified-path"
	| "config-directory"
	| "environment-file"
	| "plugin-data"
	| "talos-private"
	| "secret-storage"
	| "credential-file"
	| "bearer-token"
	| "sensitive-header"
	| "cookie"
	| "private-key"
	| "api-key"
	| "env-assignment"
	| "command-credential"
	| "cli-password";

export interface SecretInspection {
	blocked: boolean;
	reasons: SecretBlockReason[];
}

export interface SecretPolicyOptions {
	configDir?: string;
}

function blocked(reason: SecretBlockReason): SecretInspection {
	return { blocked: true, reasons: [reason] };
}

const ALLOWED: SecretInspection = { blocked: false, reasons: [] };

export function inspectVaultPath(
	path: string,
	options: SecretPolicyOptions = {}
): SecretInspection {
	let normalized = path.trim().normalize("NFKC").replace(/\\/g, "/");
	while (normalized.startsWith("./")) normalized = normalized.slice(2);
	try {
		normalized = decodeURIComponent(normalized).replace(/\\/g, "/");
	} catch {
		return blocked("unsafe-path");
	}
	const pathSegments = normalized.split("/");
	const hasUnsafeCharacter = Array.from(normalized).some((character) => {
		const code = character.charCodeAt(0);
		return (
			code <= 0x1f ||
			code === 0x7f ||
			"<>*?[]{}|".includes(character)
		);
	});
	if (
		normalized.startsWith("/") ||
		normalized.startsWith("~") ||
		/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized) ||
		hasUnsafeCharacter ||
		pathSegments.some(
			(segment, index) =>
				segment === "." ||
				segment === ".." ||
				(segment === "" && index > 0)
		)
	) {
		return blocked("unsafe-path");
	}
	const lower = normalized.toLowerCase();
	const segments = lower.split("/");
	const filename = segments[segments.length - 1] ?? "";

	if (/^\.env(?:\.|$)/.test(filename)) {
		return blocked("environment-file");
	}
	const configDir = options.configDir
		?.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "")
		.toLowerCase();
	if (
		configDir &&
		lower.startsWith(`${configDir}/plugins/`) &&
		filename === "data.json"
	) {
		return blocked("plugin-data");
	}
	if (lower === ".talos/private" || lower.startsWith(".talos/private/")) {
		return blocked("talos-private");
	}
	if (
		(configDir && (lower === configDir || lower.startsWith(`${configDir}/`))) ||
		lower === ".claudian" ||
		lower.startsWith(".claudian/") ||
		lower === ".codex" ||
		lower.startsWith(".codex/") ||
		lower === ".talos/secrets" ||
		lower.startsWith(".talos/secrets/") ||
		lower === ".talos/credentials" ||
		lower.startsWith(".talos/credentials/")
	) {
		return blocked("config-directory");
	}
	if (segments.some((segment) => segment === "secretstorage")) {
		return blocked("secret-storage");
	}
	const stem = filename.replace(/\.[^.]+$/, "");
	if (
		/(^|[-_.])(credential|credentials|token|tokens|api[-_]?key|secret|secrets)([-_.]|$)/i.test(
			stem
		)
	) {
		return blocked("credential-file");
	}
	return ALLOWED;
}

export function inspectVaultContent(
	path: string,
	content: string,
	options: SecretPolicyOptions = {}
): SecretInspection {
	const pathResult = inspectVaultPath(path, options);
	if (pathResult.blocked) return pathResult;

	if (/\bauthorization\s*:\s*bearer\s+\S+/i.test(content)) {
		return blocked("bearer-token");
	}
	if (
		/^\s*(?:x-api-key|api-key|authorization)\s*:\s*\S+/im.test(
			content
		)
	) {
		return blocked("sensitive-header");
	}
	if (/^\s*(?:cookie|set-cookie)\s*:\s*\S+/im.test(content)) {
		return blocked("cookie");
	}
	if (
		/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(
			content
		)
	) {
		return blocked("private-key");
	}
	if (
		/\b(?:sk-ant-|sk-proj-|sk-live-|sk-)[a-z0-9_-]{12,}\b/i.test(
			content
		)
	) {
		return blocked("api-key");
	}
	// 环境变量赋值：大写整词 + 下划线分段，**不带 i**。
	// 加 i 会让 max_tokens=8192 / monkey=1 / hockey=2 / secretary=小王 这类正常笔记
	// 整篇被判 blocked（`context-assembler.ts:39` 会丢内容）。
	if (
		/(?:^|\n)[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*[ \t]*=[ \t]*\S+/.test(
			content
		)
	) {
		return blocked("env-assignment");
	}
	// URL userinfo（内嵌凭据）：scheme://user:secret@host
	if (/[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i.test(content)) {
		return blocked("command-credential");
	}
	// CLI 口令：**只限定会读口令的客户端**。不用「-p 后含数字」的启发式——
	// 那会命中 ssh -p22 / docker run -p8080:80 / pip install -p3，且漏掉 mysql -pMyPassword。
	if (
		/(?:^|\s)(?:mysql|mysqldump|psql|pg_dump|redis-cli|mongosh|mongo|sqlcmd)\b[^\n]*\s-p(?!\s)\S+/i.test(
			content
		)
	) {
		return blocked("cli-password");
	}
	return ALLOWED;
}
