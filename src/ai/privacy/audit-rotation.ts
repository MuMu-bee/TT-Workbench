/**
 * TT 1.2.0(审查 P5):JSONL 审计文件轮转。
 * 审计记录只增不改,长时间使用会无界增长(日志类文件风险:磁盘占满 + 解析变慢)。
 * 策略:写入前检查文件大小,超过上限则把当前文件重命名为 `<name>.1`
 * (覆盖上一份备份,总量恒定为上限的 2 倍以内),再继续追加。
 * 不删除任何记录:旧记录保留在 .1 备份里,可人工归档。
 */
export const AUDIT_ROTATE_BYTES = 4 * 1024 * 1024;

export interface RotationFileHost {
	size(path: string): Promise<number | null>;
	rename(from: string, to: string): Promise<void>;
}

/** 返回是否发生了轮转(供调用方记录/测试断言)。 */
export async function rotateIfOversized(
	filePath: string,
	host: RotationFileHost,
	limitBytes = AUDIT_ROTATE_BYTES
): Promise<boolean> {
	const size = await host.size(filePath);
	if (size === null || size < limitBytes) return false;
	await host.rename(filePath, `${filePath}.1`);
	return true;
}
