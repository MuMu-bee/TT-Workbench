#!/usr/bin/env node
/**
 * 模块依赖方向静态检查（ROADMAP.md:34「模块依赖方向检查脚本」）。
 *
 * 三条规则：
 *  ①adapters-legacy-to-ai-provider（主规则）：`src/agent-workbench/{adapters,legacy}/**`
 *    不得 `import` `src/ai/provider/*`。这是 ROADMAP.md:34 原文点名的方向
 *    ——adapters/api 与 legacy 必须经 contracts 或端口接口访问 ai/provider。
 *    存量违规已逐条进 `scripts/module-boundaries-baseline.json`（F6 端口化未完成），
 *    新增违规会使本条失败。
 *  ②contracts-no-parent-import（护栏，当前基线 0，纯防回退）：`src/agent-workbench/contracts/**`
 *    不得写出跨出 contracts 目录的相对导入（`from "..` 形态）。
 *  ③layer-no-upward-import（护栏，当前基线 0，纯防回退）：`src/agent-workbench/{core,storage,security}/**`
 *    不得 import `ui` / `adapters` / `transports` / `discovery` 四个上层目录，
 *    也不得 import Obsidian 包（这三层必须可脱离插件宿主测试）。
 *
 * 形状照 `scripts/check-peer-status-bundle.mjs`：导出纯函数 + `main()` + 非零退出码，
 * 可被测试直接 import。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, relative, sep } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export const BASELINE_PATH = "scripts/module-boundaries-baseline.json";
export const QUYUAN_ORPHAN_BASELINE_PATH = "scripts/quyuan-orphan-contracts-baseline.json";

export const RULES = {
	adaptersLegacyToAiProvider: "adapters-legacy-to-ai-provider",
	contractsNoParentImport: "contracts-no-parent-import",
	layerNoUpwardImport: "layer-no-upward-import",
	quyuanNoOrphanContract: "quyuan-no-orphan-contract",
};

/** 主规则：这些目录不得直连 ai/provider。 */
const ADAPTER_LAYER_DIRS = ["src/agent-workbench/adapters", "src/agent-workbench/legacy"];
/** 护栏：这些目录不得写跨出自身目录的相对导入。 */
const CONTRACTS_DIR = "src/agent-workbench/contracts";
/** 护栏：这些底层目录不得 import 上层目录。 */
const LOWER_LAYER_DIRS = [
	"src/agent-workbench/core",
	"src/agent-workbench/storage",
	"src/agent-workbench/security",
];
const UPPER_LAYER_DIRS = ["ui", "adapters", "transports", "discovery"].map(
	(name) => `src/agent-workbench/${name}`,
);
const AI_PROVIDER_DIR = "src/ai/provider";
const HOST_PACKAGE = "obsidian";
/** Q-ARC6 护栏：屈原目录下不得再长出「只定义 interface、全仓无 implements」的孤岛契约。 */
const QUYUAN_DIR = "src/quyuan";

/** 匹配静态 import / export-from / bare import 三种形态。 */
const IMPORT_PATTERN =
	/^\s*(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/gm;

function slash(value) {
	return value.split(sep).join("/");
}

function sourceFiles(dir, found = []) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return found;
	}
	for (const name of entries) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) sourceFiles(full, found);
		else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) found.push(full);
	}
	return found;
}

function isUnder(target, directory) {
	return target === directory || target.startsWith(`${directory}/`);
}

/**
 * 把导入说明符解析成「相对仓库根的 posix 路径」。
 * 裸包名原样返回（用于 `obsidian` 判定）。
 */
function resolveSpecifier(fileRelative, specifier) {
	if (!specifier.startsWith(".")) return specifier;
	const base = dirname(fileRelative);
	return slash(normalize(join(base, specifier)));
}

/**
 * 扫描三条规则覆盖的目录，返回全量违规（不套白名单，便于测试直接断言）。
 * @param {string} repoRoot 仓库根目录
 * @returns {{ violations: Array<{file: string, line: number, text: string, rule: string, specifier: string}> }}
 */
export function checkBoundaries(repoRoot) {
	const violations = [];
	const scanned = [
		...ADAPTER_LAYER_DIRS,
		CONTRACTS_DIR,
		...LOWER_LAYER_DIRS,
	];
	for (const directory of scanned) {
		for (const absolute of sourceFiles(join(repoRoot, directory))) {
			const fileRelative = slash(relative(repoRoot, absolute));
			const source = readFileSync(absolute, "utf8");
			const lines = source.split(/\r?\n/);
			for (const match of source.matchAll(IMPORT_PATTERN)) {
				const specifier = match[1];
				const line = source.slice(0, match.index).split(/\r?\n/).length;
				const text = (lines[line - 1] ?? "").trim();
				const target = resolveSpecifier(fileRelative, specifier);
				for (const rule of evaluate({ fileRelative, specifier, target })) {
					violations.push({ file: fileRelative, line, text, rule, specifier });
				}
			}
		}
	}
	return { violations };
}

function evaluate({ fileRelative, specifier, target }) {
	const rules = [];
	if (
		ADAPTER_LAYER_DIRS.some((directory) => isUnder(fileRelative, directory))
		&& isUnder(target, AI_PROVIDER_DIR)
	) {
		rules.push(RULES.adaptersLegacyToAiProvider);
	}
	if (isUnder(fileRelative, CONTRACTS_DIR) && specifier.startsWith("..")) {
		rules.push(RULES.contractsNoParentImport);
	}
	if (LOWER_LAYER_DIRS.some((directory) => isUnder(fileRelative, directory))) {
		if (UPPER_LAYER_DIRS.some((directory) => isUnder(target, directory))) {
			rules.push(RULES.layerNoUpwardImport);
		}
		if (target === HOST_PACKAGE) rules.push(RULES.layerNoUpwardImport);
	}
	return rules;
}

export function loadBaseline(repoRoot) {
	const raw = JSON.parse(readFileSync(join(repoRoot, BASELINE_PATH), "utf8"));
	if (!Array.isArray(raw?.allowed)) {
		throw new Error(`${BASELINE_PATH} 缺少 allowed 数组`);
	}
	for (const entry of raw.allowed) {
		if (!entry.file || !entry.rule || !entry.specifier) {
			throw new Error(`${BASELINE_PATH} 每条白名单必须写明 file / rule / specifier`);
		}
		// 白名单每条必须带追踪信息：issue 或到期复核日期，防止把存量违规「合法化」后无人跟踪。
		if (!entry.issue && !entry.reviewBy) {
			throw new Error(
				`${BASELINE_PATH} 白名单 ${entry.file} (${entry.rule}) 缺少 issue 或 reviewBy 追踪信息`,
			);
		}
	}
	return raw.allowed;
}

function baselineKey(entry) {
	return `${entry.file}\u0000${entry.rule}\u0000${entry.specifier}`;
}

/** 过滤掉白名单内的存量违规，并报告白名单里已失效（不再命中）的条目。 */
export function partition(violations, allowed) {
	const allowedKeys = new Set(allowed.map(baselineKey));
	const hit = new Set();
	const blocking = [];
	for (const violation of violations) {
		const key = baselineKey(violation);
		if (allowedKeys.has(key)) hit.add(key);
		else blocking.push(violation);
	}
	const stale = allowed.filter((entry) => !hit.has(baselineKey(entry)));
	return { blocking, stale };
}

export function formatViolation(violation) {
	return `${violation.file}:${violation.line} [${violation.rule}] ${violation.text}`;
}

/**
 * Q-ARC6 护栏：`src/quyuan/` 下不得再长出「只给测试读的契约孤岛」。
 *
 * 背景：`contract.ts` 曾定义 `QuyuanWorkbenchAdapter` 等契约却零实现，唯一消费者是
 * `tests/governance.test.ts`，把「能力合同已覆盖」误当成「实现已验证」。该组 4 个文件
 * 已删除，本条防止同类孤岛回流。
 *
 * 判定（对应方案第 6 步的字面要求）：`src/quyuan/` 下某个文件导出了 interface，
 * 但全仓（src + tests）没有任何 `implements <该 interface>`，**且**该文件在 `src/`
 * 内无人 import（`tests/` 内被 import 恰恰是孤岛的典型特征）→ 计一条违规。
 *
 * 存量由 `quyuan-orphan-contracts-baseline.json` 记录（本轮之前就存在、不在 Q-ARC6
 * 删除范围内的 `local-voice-supply-chain.ts`），新增孤岛即失败。
 *
 * @param {string} repoRoot 仓库根目录
 * @returns {{ violations: Array<{file: string, line: number, text: string, rule: string, specifier: string}> }}
 */
export function checkQuyuanOrphanContracts(repoRoot) {
	const violations = [];
	const repo = (directory) => sourceFiles(join(repoRoot, directory)).map((absolute) => ({
		file: slash(relative(repoRoot, absolute)),
		source: readFileSync(absolute, "utf8"),
	}));
	const srcSources = repo("src");
	const testSources = repo("tests");
	const everyone = [...srcSources, ...testSources];

	/**
	 * 某文件是否被另一处 import 指向。
	 * 比对解析后的仓库相对路径（不靠 basename 猜）——`resolveSpecifier` 不补扩展名，
	 * 故把「带 .ts」与「不带 .ts」两种写法都算命中。
	 */
	const importedBy = (targetFile, candidates) => {
		const targetNoExt = targetFile.replace(/\.ts$/, "");
		return candidates.some((other) => {
			if (other.file === targetFile) return false;
			for (const match of other.source.matchAll(IMPORT_PATTERN)) {
				const resolved = resolveSpecifier(other.file, match[1]).replace(/\.ts$/, "");
				if (resolved === targetNoExt) return true;
			}
			return false;
		});
	};

	for (const entry of repo(QUYUAN_DIR)) {
		// barrel 只做 re-export，契约住在被导出的文件里。
		if (entry.file.endsWith("/index.ts")) continue;
		const declared = [...entry.source.matchAll(/^export\s+interface\s+([A-Za-z0-9_]+)/gm)]
			.map((match) => match[1]);
		if (declared.length === 0) continue;
		const implemented = declared.some((name) =>
			everyone.some((other) => other.source.includes(`implements ${name}`))
		);
		if (implemented) continue;
		// 被产品代码真实 import 的接口文件（如 qwen-realtime-voice 的 port 集合）不算孤岛：
		// 它们的价值在「声明宿主边界」，`implements` 由测试夹具与宿主对象提供。
		if (importedBy(entry.file, srcSources)) continue;
		const usedByTests = importedBy(entry.file, testSources);
		violations.push({
			file: entry.file,
			line: firstInterfaceLine(entry.source),
			text: `导出 ${declared.length} 个 interface、全仓无 implements、src/ 内无导入`
				+ `${usedByTests ? "（只被 tests/ 引用）" : ""}：${declared.join(", ")}`,
			rule: RULES.quyuanNoOrphanContract,
			specifier: entry.file,
		});
	}
	return { violations };
}

function firstInterfaceLine(source) {
	const match = /^export\s+interface\s+[A-Za-z0-9_]+/m.exec(source);
	if (!match) return 1;
	return source.slice(0, match.index).split(/\r?\n/).length;
}

export function loadQuyuanOrphanBaseline(repoRoot) {
	const raw = JSON.parse(
		readFileSync(join(repoRoot, QUYUAN_ORPHAN_BASELINE_PATH), "utf8")
	);
	if (!Array.isArray(raw?.allowed)) {
		throw new Error(`${QUYUAN_ORPHAN_BASELINE_PATH} 缺少 allowed 数组`);
	}
	return raw.allowed;
}

function main() {
	let allowed;
	try {
		allowed = loadBaseline(root);
	} catch (error) {
		console.error(`模块边界检查无法读取白名单：${error.message}`);
		process.exit(1);
	}
	const { violations } = checkBoundaries(root);
	const { blocking, stale } = partition(violations, allowed);
	for (const entry of stale) {
		console.error(
			`白名单条目已失效（不再命中，请从 ${BASELINE_PATH} 删除）：${entry.file} [${entry.rule}]`,
		);
	}
	if (blocking.length > 0) {
		for (const violation of blocking) console.error(formatViolation(violation));
		console.error(`模块边界检查失败：${blocking.length} 条违规不在白名单内`);
		process.exit(1);
	}
	// Q-ARC6 护栏：屈原目录下不得再长出只给测试读的契约孤岛。
	let orphanAllowed;
	try {
		orphanAllowed = loadQuyuanOrphanBaseline(root);
	} catch (error) {
		console.error(`模块边界检查无法读取屈原孤岛白名单：${error.message}`);
		process.exit(1);
	}
	const orphans = checkQuyuanOrphanContracts(root).violations;
	const tracked = new Set(orphanAllowed.map((entry) => entry.file));
	const newOrphans = orphans.filter((violation) => !tracked.has(violation.file));
	for (const violation of newOrphans) console.error(formatViolation(violation));
	if (newOrphans.length > 0) {
		console.error(`模块边界检查失败：${newOrphans.length} 个新增屈原契约孤岛`);
		process.exit(1);
	}
	console.log(
		`模块边界检查通过：${violations.length} 条存量违规全部在白名单内`
		+ `（主规则 ${RULES.adaptersLegacyToAiProvider} + 3 条护栏，屈原契约孤岛 ${orphans.length} 条）`,
	);
}

if (process.argv[1] && process.argv[1].endsWith("check-module-boundaries.mjs")) {
	main();
}
