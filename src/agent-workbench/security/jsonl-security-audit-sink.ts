import path from "node:path";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { rotateIfOversized } from "../../ai/privacy/audit-rotation";
import type { SecurityAuditRecord, SecurityAuditSink } from "./security-audit";

export class JsonlSecurityAuditSink implements SecurityAuditSink {
	constructor(private readonly vaultRoot: string) {}
	async append(record: SecurityAuditRecord): Promise<void> {
		const directory = path.join(this.vaultRoot, ".talos", "agent-workbench", "v1");
		await mkdir(directory, { recursive: true });
		const file = path.join(directory, "security-audit.jsonl");
		// P5:超过上限先轮转为 .1 备份(审计记录不删除,可人工归档)。
		await rotateIfOversized(file, {
			size: async (target) => {
				try {
					return (await stat(target)).size;
				} catch {
					return null;
				}
			},
			rename: (from, to) => rename(from, to),
		});
		await appendFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
	}
}
