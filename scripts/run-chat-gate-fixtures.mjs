#!/usr/bin/env node
/**
 * chat-gate 合成夹具跑法（Q-TES9）。
 *
 * `agent-workbench-chat-gate.selftest.mjs` 自述为「唯一的功能硬门」，但此前不在 CI 上跑，
 * 因为它被当成「需要真实 Vault + 已连接运行时」的手工门。实测它只读
 * `.talos/agent-workbench/v1/conversations/**\/events/*.json`，一套合成目录就够：
 * 本脚本对 `fixtures/chat-gate/` 下的正例断言退出码 0、反例断言退出码 1，
 * 于是这扇门每次提交都被执行，而不是停在文档里的手工项。
 *
 * 夹具的三个必需字段（漏掉会得到「完整有序回合：0」的假红）：
 *  - `conversationId`：回合按 `conversationId:turnId` 分组，缺了分组键是空的；
 *  - `turnId`：同上，且 `user.message` / `assistant.final` / `turn.finished` 必须同值；
 *  - `assistant.final` 的 `payload.text` 必须非空，否则不计入「带非空文本的
 *    assistant.final」，整条回合也不合格。
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, posix } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const GATE_SCRIPT = "agent-workbench-chat-gate.selftest.mjs";

/** 正例（应当 exit 0）与反例（应当 exit 1）夹具的相对路径。 */
export const CASES = [
	{ name: "pass", fixture: "fixtures/chat-gate/pass", expectedExitCode: 0 },
	{ name: "fail-no-finish", fixture: "fixtures/chat-gate/fail-no-finish", expectedExitCode: 1 },
];

/** 跑一个夹具，返回 `{ name, exitCode, expectedExitCode, ok, output }`。 */
export function runCase(testCase, repoRoot = root) {
	const result = spawnSync(
		process.execPath,
		[posix.join(repoRoot, GATE_SCRIPT), posix.join(repoRoot, testCase.fixture)],
		{ cwd: repoRoot, encoding: "utf8" }
	);
	const exitCode = result.status;
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	return {
		name: testCase.name,
		exitCode,
		expectedExitCode: testCase.expectedExitCode,
		ok: exitCode === testCase.expectedExitCode,
		output,
	};
}

export function runAll(repoRoot = root) {
	const results = CASES.map((testCase) => runCase(testCase, repoRoot));
	return { results, failed: results.filter((result) => !result.ok) };
}

export function main(repoRoot = root) {
	const { results, failed } = runAll(repoRoot);
	for (const result of results) {
		const status = result.ok ? "PASS" : "FAIL";
		console.log(
			`${status} 夹具 ${result.name} 退出码 ${result.exitCode}（期望 ${result.expectedExitCode}）`
		);
	}
	if (failed.length > 0) {
		for (const result of failed) console.error(`--- ${result.name} 输出 ---\n${result.output}`);
		return 1;
	}
	console.log("PASS chat-gate 合成夹具全部符合预期");
	return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exit(main());
}
