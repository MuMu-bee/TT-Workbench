// 屈原诊断报告的运行时错误渲染与脱敏。
// 纯模块：只做类型导入（`import type` 在打包时被完全擦除），不依赖 obsidian，
// 因此单元测试可直接加载，无需拉起源码里 `view.ts → obsidian` 的整条依赖链。
import { sanitizeAuditValue } from "../task-core/audit-sanitizer";
import type { QuyuanRuntimeErrorRecord } from "./plugin-support";

/**
 * 渲染「最近运行时错误」小节的 Markdown 行。
 *
 * `message` 与 `stack` 都先过 `sanitizeAuditValue`：诊断报告写进 `reportsFolder`
 * 后可能随 Vault 同步/分享外泄，而 stack 天然带本机绝对路径。
 * 调用点 `quyuan-diagnostics.ts` 只做转发，脱敏只在这里发生。
 */
export function formatRuntimeErrorLines(
	items: readonly QuyuanRuntimeErrorRecord[]
): string[] {
	if (items.length === 0) return ["- 暂无记录。"];
	return items.flatMap((item, index) => [
		`### ${index + 1}. ${item.scope}`,
		"",
		`- 时间：${item.at}`,
		`- 错误：${String(sanitizeAuditValue(item.message))}`,
		"",
		"```text",
		String(sanitizeAuditValue(item.stack)) || "(no stack)",
		"```",
		"",
	]);
}
