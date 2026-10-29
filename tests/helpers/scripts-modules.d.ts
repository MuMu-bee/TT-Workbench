// 仓库根的守卫脚本是 .mjs（不进 tsc 的 src 编译面），测试要 import 它们做断言。
// 这里补声明，避免 `tsc -p tests/tsconfig.json` 报 TS7016「implicitly has an 'any' type」。
// 每次往 scripts/ 新增被测试 import 的 .mjs 时，在此补一条声明。

declare module "*check-peer-status-bundle.mjs" {
	export const FORBIDDEN_PATTERNS: RegExp[];
	export function dynamicFsPromisesImports(bundleText: string): string[];
	export function assertBundleSafe(bundleText: string): boolean;
}

declare module "*check-module-boundaries.mjs" {
	export interface BoundaryViolation {
		file: string;
		line: number;
		text: string;
		rule: string;
		specifier: string;
	}
	export interface BoundaryBaselineEntry {
		file: string;
		rule: string;
		specifier: string;
		note?: string;
		issue?: string;
		reviewBy?: string;
	}
	export const BASELINE_PATH: string;
	export const QUYUAN_ORPHAN_BASELINE_PATH: string;
	export const RULES: {
		adaptersLegacyToAiProvider: string;
		contractsNoParentImport: string;
		layerNoUpwardImport: string;
		quyuanNoOrphanContract: string;
	};
	export function checkBoundaries(repoRoot: string): { violations: BoundaryViolation[] };
	export function loadBaseline(repoRoot: string): BoundaryBaselineEntry[];
	export function partition(
		violations: BoundaryViolation[],
		allowed: BoundaryBaselineEntry[],
	): { blocking: BoundaryViolation[]; stale: BoundaryBaselineEntry[] };
	export function formatViolation(violation: BoundaryViolation): string;
	/** Q-ARC6 护栏：屈原目录下的契约孤岛检查。 */
	export function checkQuyuanOrphanContracts(
		repoRoot: string,
	): { violations: BoundaryViolation[] };
	export function loadQuyuanOrphanBaseline(
		repoRoot: string,
	): Array<{ file: string; note?: string; issue?: string; reviewBy?: string }>;
}

declare module "*check-file-size.mjs" {
	export interface FileSizeMeasurement {
		file: string;
		lines: number;
	}
	export interface FunctionSizeMeasurement {
		file: string;
		name: string;
		expectedStartLine: number;
		startLine: number | null;
		endLine: number | null;
		lines: number | null;
		found: boolean;
	}
	export interface FileSizeViolation {
		kind: "file" | "function";
		target: string;
		rule: string;
		measured: number | null;
		limit: number | null;
		message: string;
	}
	export const BASELINE_PATH: string;
	export const FILE_TARGET_LINES: number;
	export const FUNCTION_TARGET_LINES: number;
	export const GATED_FILES: string[];
	export const GATED_FUNCTIONS: Array<{
		file: string;
		name: string;
		signature: string;
		startLine: number;
	}>;
	export function countFileLines(source: string): number;
	export function measureFunction(
		source: string,
		signature: string,
	): { startLine: number; endLine: number; lines: number } | null;
	export function measureFileSizes(repoRoot?: string): FileSizeMeasurement[];
	export function measureFunctionSizes(repoRoot?: string): FunctionSizeMeasurement[];
	export function loadBaseline(repoRoot?: string): {
		comment: string;
		files: Record<string, number>;
		functions: Record<string, number>;
		targets: { fileLines: number; functionLines: number; source: string };
	};
	export function checkFileSizes(
		repoRoot?: string,
		baseline?: ReturnType<typeof loadBaseline>,
	): {
		files: FileSizeMeasurement[];
		functions: FunctionSizeMeasurement[];
		violations: FileSizeViolation[];
		improvements: string[];
	};
	export function checkTargets(repoRoot?: string): {
		files: FileSizeMeasurement[];
		functions: FunctionSizeMeasurement[];
		violations: FileSizeViolation[];
	};
	export function main(argv?: string[]): number;
}

declare module "*run-chat-gate-fixtures.mjs" {
	export interface ChatGateCase {
		name: string;
		fixture: string;
		expectedExitCode: number;
	}
	export interface ChatGateCaseResult {
		name: string;
		exitCode: number | null;
		expectedExitCode: number;
		ok: boolean;
		output: string;
	}
	export const GATE_SCRIPT: string;
	export const CASES: ChatGateCase[];
	export function runCase(testCase: ChatGateCase, repoRoot?: string): ChatGateCaseResult;
	export function runAll(repoRoot?: string): {
		results: ChatGateCaseResult[];
		failed: ChatGateCaseResult[];
	};
	export function main(repoRoot?: string): number;
}
