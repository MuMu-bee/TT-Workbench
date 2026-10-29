#!/usr/bin/env node
/**
 * 文件/函数体量门（ROADMAP.md:31-33 的「单文件 ≤800 行」「函数 ≤100 行」）。
 *
 * 形状照 `scripts/check-module-boundaries.mjs`：导出纯函数 + `main()` + 非零退出码，
 * 可被测试直接 import。
 *
 * 为什么不是「直接断言 ≤800 / ≤100」：本轮落地时实测 `src/quyuan/voice-panel.ts`
 * 1534 行（`mount()` 196-503，约 308 行）、`src/quyuan/qwen-realtime-voice.ts` 1160 行
 * （`handleServerEvent()` 712-872，161 行）、`agent-execution-coordinator.ts` 的
 * `execute()` 237-489、`talos-agent-workbench.ts` 的 `build()` 160-460。
 * 拆分本身是 ROADMAP 批次三 F1/F2/F3/F4，方案里也标为「大工作量 + 依赖 Q-TES5」，
 * 门槛先落成**棘轮（ratchet）**：把当时的实测值记为基线，只允许下降，不允许回涨。
 * 拆分推进时把 `scripts/file-size-baseline.json` 里的数字下调到当时实测值即可。
 *
 * 两个模式：
 *  - 默认：棘轮模式。超出基线即失败（防回退），并额外打印距目标阈值的差额。
 *  - `--targets`：目标模式。按 ROADMAP 的 800 / 100 硬阈值判定，拆分完成前必红。
 *
 * 度量口径：
 *  - 文件行数 = `split(/\r?\n/)` 的长度（与 `wc -l` 的「换行数」相差末行；本脚本按
 *    行数组长度算，避免 Windows/Linux 末行换行差异）。
 *  - 函数长度 = 从签名行到与之匹配的右花括号所在行，闭区间计数。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, posix } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export const BASELINE_PATH = "scripts/file-size-baseline.json";

/** ROADMAP.md:31-32 的目标：这两个文件单文件 ≤800 行。 */
export const FILE_TARGET_LINES = 800;
/** ROADMAP.md:33 的目标：函数 ≤100 行。 */
export const FUNCTION_TARGET_LINES = 100;

/** 纳入门的文件（路径相对仓库根，一律 posix 分隔）。 */
export const GATED_FILES = [
	"src/quyuan/voice-panel.ts",
	"src/quyuan/qwen-realtime-voice.ts",
];

/**
 * 四个函数的定位特征。`signature` 是唯一子串，`startLine` 是落地时的实测起始行
 * （行号漂移时这条先红，避免门悄悄量到别的函数）。
 */
export const GATED_FUNCTIONS = [
	{
		file: "src/quyuan/voice-panel.ts",
		name: "mount()",
		signature: "\tmount(container: HTMLElement): void {",
		startLine: 196,
	},
	{
		file: "src/agent-workbench/core/agent-execution-coordinator.ts",
		name: "execute()",
		signature: "\tasync *execute(",
		startLine: 237,
	},
	{
		file: "src/agent-workbench/ui/talos-agent-workbench.ts",
		name: "build()",
		signature: "\tprivate build(doc: Document): void {",
		startLine: 160,
	},
	{
		file: "src/quyuan/qwen-realtime-voice.ts",
		name: "handleServerEvent()",
		signature: "\tprivate handleServerEvent(event: Record<string, unknown>): void {",
		startLine: 758,
	},
];

function splitLines(source) {
	return source.split(/\r?\n/);
}

/** 文件行数（含最后一行；与 `wc -l` 只差末行是否有换行）。 */
export function countFileLines(source) {
	const lines = splitLines(source);
	// 末尾空串不计入（多数编辑器都会以换行结尾）。
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.length;
}

/**
 * 从 `signature` 所在行起做花括号配平，返回 `{ startLine, endLine, lines }`。
 * 找不到签名时返回 null（由调用方判为度量失败，而不是静默跳过）。
 *
 * 先跳过参数表（括号配平）再找函数体的左花括号：多行签名的默认参数里可能有
 * `= {}` 这种已配平的空对象字面量（`execute()` 的 `interactions = {}`），
 * 直接按花括号配平会把它当成函数体结束，把 240 行的函数量成 4 行。
 */
export function measureFunction(source, signature) {
	const lines = splitLines(source);
	const startIndex = lines.findIndex((line) => line.trimEnd() === signature.trimEnd());
	if (startIndex < 0) return null;
	let parenDepth = 0;
	let bodyStarted = false;
	let braceDepth = 0;
	for (let index = startIndex; index < lines.length; index += 1) {
		for (const char of lines[index]) {
			if (!bodyStarted) {
				if (char === "(") parenDepth += 1;
				else if (char === ")") parenDepth -= 1;
				else if (char === "{" && parenDepth === 0) {
					bodyStarted = true;
					braceDepth = 1;
				}
				continue;
			}
			if (char === "{") braceDepth += 1;
			else if (char === "}") braceDepth -= 1;
		}
		if (bodyStarted && braceDepth === 0) {
			return { startLine: startIndex + 1, endLine: index + 1, lines: index - startIndex + 1 };
		}
	}
	return null;
}

export function measureFileSizes(repoRoot = root) {
	return GATED_FILES.map((file) => ({
		file,
		lines: countFileLines(readFileSync(posix.join(repoRoot, file), "utf8")),
	}));
}

export function measureFunctionSizes(repoRoot = root) {
	return GATED_FUNCTIONS.map((target) => {
		const source = readFileSync(posix.join(repoRoot, target.file), "utf8");
		const measured = measureFunction(source, target.signature);
		return {
			file: target.file,
			name: target.name,
			expectedStartLine: target.startLine,
			startLine: measured?.startLine ?? null,
			endLine: measured?.endLine ?? null,
			lines: measured?.lines ?? null,
			found: measured !== null,
		};
	});
}

export function loadBaseline(repoRoot = root) {
	return JSON.parse(readFileSync(posix.join(repoRoot, BASELINE_PATH), "utf8"));
}

function baselineKeyOfFile(file) {
	return file;
}

function baselineKeyOfFunction(file, name) {
	return `${file}#${name}`;
}

/**
 * 棘轮判定：实测值 > 基线值即为违规（回涨）；实测值 < 基线值只提示可下调。
 * 文件/函数度量失败（找不到签名）视为违规，不能靠改签名绕过门。
 */
export function checkFileSizes(repoRoot = root, baseline = loadBaseline(repoRoot)) {
	const files = measureFileSizes(repoRoot);
	const functions = measureFunctionSizes(repoRoot);
	const violations = [];
	const improvements = [];

	for (const measured of files) {
		const limit = baseline.files?.[baselineKeyOfFile(measured.file)];
		if (typeof limit !== "number") {
			violations.push({
				kind: "file",
				target: measured.file,
				rule: "missing-baseline",
				measured: measured.lines,
				limit: null,
				message: `基线缺少 ${measured.file} 的记录`,
			});
			continue;
		}
		if (measured.lines > limit) {
			violations.push({
				kind: "file",
				target: measured.file,
				rule: "file-size-regression",
				measured: measured.lines,
				limit,
				message: `${measured.file} ${measured.lines} 行 > 基线 ${limit} 行（ROADMAP.md:31-32 目标 ${FILE_TARGET_LINES} 行）`,
			});
		} else if (measured.lines < limit) {
			improvements.push(`${measured.file} ${measured.lines} 行 < 基线 ${limit} 行，可下调基线`);
		}
	}

	for (const measured of functions) {
		if (!measured.found) {
			violations.push({
				kind: "function",
				target: `${measured.file}#${measured.name}`,
				rule: "signature-not-found",
				measured: null,
				limit: null,
				message: `${measured.file} 里找不到 ${measured.name} 的签名，无法度量`,
			});
			continue;
		}
		const limit = baseline.functions?.[baselineKeyOfFunction(measured.file, measured.name)];
		if (typeof limit !== "number") {
			violations.push({
				kind: "function",
				target: `${measured.file}#${measured.name}`,
				rule: "missing-baseline",
				measured: measured.lines,
				limit: null,
				message: `基线缺少 ${measured.file}#${measured.name} 的记录`,
			});
			continue;
		}
		if (measured.lines > limit) {
			violations.push({
				kind: "function",
				target: `${measured.file}#${measured.name}`,
				rule: "function-size-regression",
				measured: measured.lines,
				limit,
				message: `${measured.file} 的 ${measured.name} ${measured.lines} 行 > 基线 ${limit} 行（ROADMAP.md:33 目标 ${FUNCTION_TARGET_LINES} 行）`,
			});
		} else if (measured.lines < limit) {
			improvements.push(
				`${measured.file} 的 ${measured.name} ${measured.lines} 行 < 基线 ${limit} 行，可下调基线`
			);
		}
	}

	return { files, functions, violations, improvements };
}

/** 目标模式：按 ROADMAP 的硬阈值判定（拆分完成前必红）。 */
export function checkTargets(repoRoot = root) {
	const files = measureFileSizes(repoRoot);
	const functions = measureFunctionSizes(repoRoot);
	const violations = [];
	for (const measured of files) {
		if (measured.lines > FILE_TARGET_LINES) {
			violations.push({
				kind: "file",
				target: measured.file,
				rule: "file-size-target",
				measured: measured.lines,
				limit: FILE_TARGET_LINES,
				message: `${measured.file} ${measured.lines} 行 > 目标 ${FILE_TARGET_LINES} 行`,
			});
		}
	}
	for (const measured of functions) {
		if (!measured.found) {
			violations.push({
				kind: "function",
				target: `${measured.file}#${measured.name}`,
				rule: "signature-not-found",
				measured: null,
				limit: null,
				message: `${measured.file} 里找不到 ${measured.name} 的签名，无法度量`,
			});
			continue;
		}
		if (measured.lines > FUNCTION_TARGET_LINES) {
			violations.push({
				kind: "function",
				target: `${measured.file}#${measured.name}`,
				rule: "function-size-target",
				measured: measured.lines,
				limit: FUNCTION_TARGET_LINES,
				message: `${measured.file} 的 ${measured.name} ${measured.lines} 行 > 目标 ${FUNCTION_TARGET_LINES} 行`,
			});
		}
	}
	return { files, functions, violations };
}

export function main(argv = process.argv.slice(2)) {
	const targets = argv.includes("--targets");
	const result = targets ? checkTargets(root) : checkFileSizes(root);
	for (const file of result.files) {
		console.log(`file ${file.file} ${file.lines} 行（目标 ≤${FILE_TARGET_LINES}）`);
	}
	for (const fn of result.functions) {
		console.log(
			`func ${fn.file}#${fn.name} ${fn.lines ?? "?"} 行（${fn.startLine ?? "?"}-${fn.endLine ?? "?"}，目标 ≤${FUNCTION_TARGET_LINES}）`
		);
	}
	for (const note of result.improvements ?? []) console.log(`note ${note}`);
	if (result.violations.length === 0) {
		console.log(targets ? "PASS 体量目标全部满足" : "PASS 无体量回涨（棘轮基线）");
		return 0;
	}
	for (const violation of result.violations) console.error(`FAIL ${violation.message}`);
	return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exit(main());
}
