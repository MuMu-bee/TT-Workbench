const SENSITIVE_KEY =
	/(authorization|api[-_]?key|token|secret|cookie|password|credential)/i;
const SENSITIVE_VALUE =
	/(?:Bearer\s+\S+|sk-(?:ant-)?[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|(?:token|api[-_]?key)\s*=\s*\S+)/gi;
/**
 * 与 `secret-policy.ts` 同样收紧的两条结构保留规则：只替换凭据本身，
 * 保留 URL scheme+host（`$1`）与客户端名，取证价值不降。
 * 刻意**不**复用 env 的宽松形态与任何端口启发式——实测那会抹掉
 * `docker run -p8080:80 nginx` 与 `ssh -p22 deploy@host` 的取证信息。
 */
const URL_USERINFO =
	/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi;
const CLI_PASSWORD =
	/((?:^|\s)(?:mysql|mysqldump|psql|pg_dump|redis-cli|mongosh|mongo|sqlcmd)\b[^\n]*?\s-p)(?!\s)\S+/gi;
const HOME_PATH =
	/(?:\/(?:Users|home)\/[^/\s:;,"')\]}!?]+|[A-Za-z]:\\Users\\[^\\\s:;,"')\]}!?]+)(?:[/\\][^\s:;,"')\]}!?]+)*/g;

function sanitizeString(value: string): string {
	SENSITIVE_VALUE.lastIndex = 0;
	const secretsRedacted = value.replace(SENSITIVE_VALUE, "[REDACTED]");
	SENSITIVE_VALUE.lastIndex = 0;
	URL_USERINFO.lastIndex = 0;
	const userinfoRedacted = secretsRedacted.replace(
		URL_USERINFO,
		"$1[REDACTED]@"
	);
	URL_USERINFO.lastIndex = 0;
	CLI_PASSWORD.lastIndex = 0;
	const cliRedacted = userinfoRedacted.replace(CLI_PASSWORD, "$1[REDACTED]");
	CLI_PASSWORD.lastIndex = 0;
	HOME_PATH.lastIndex = 0;
	const sanitized = cliRedacted.replace(HOME_PATH, (match) => {
		const trailingPunctuation = /[.!?]+$/.exec(match)?.[0] ?? "";
		return `[HOME_PATH]${trailingPunctuation}`;
	});
	HOME_PATH.lastIndex = 0;
	return sanitized;
}

export function sanitizeAuditValue(value: unknown): unknown {
	if (typeof value === "string") return sanitizeString(value);
	if (Array.isArray(value)) return value.map((item) => sanitizeAuditValue(item));
	if (!value || typeof value !== "object") return value;

	const sanitized: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value)) {
		sanitized[key] = SENSITIVE_KEY.test(key)
			? "[REDACTED]"
			: sanitizeAuditValue(nested);
	}
	return sanitized;
}
