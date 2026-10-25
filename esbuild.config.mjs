import esbuild from 'esbuild';
import process from 'process';
import { builtinModules } from 'node:module';
import { readFile } from 'node:fs/promises';

// 经审计的第三方浏览器运行时以文本快照进入 bundle，再由专用 Worker 执行。
// 仅匹配仓库内的 *.vendor.txt；运行时不解析 URL、不下载或执行远程 JavaScript。
const staticVendorText = {
	name: 'static-vendor-text',
	setup(build) {
		build.onLoad({ filter: /\.vendor\.txt$/ }, async (args) => ({
			contents: await readFile(args.path, 'utf8'),
			loader: 'text',
		}));
	},
};

const banner = `/*
TT-Workbench (TT工作台) 1.0.0 — customized fork of TALOS v0.4.9.
Modifications are listed in MODIFICATIONS.md; upstream: github.com/WAINAO-Haaper/talos-plugin

TALOS PERSONAL USE SOURCE LICENSE 1.0
Copyright (c) 2026 外脑玩家 Haaper.
Source available for personal, non-commercial use.
Commercial use requires prior written authorization. See LICENSE.

This generated bundle contains third-party software governed by separate
licenses and service terms. Any distribution of this file MUST include:
LICENSE, THIRD-PARTY-NOTICES.md, and THIRD-PARTY-LICENSES.txt.
*/
// import.meta.url 运行时 shim（跨平台）：
// 旧实现 define 成写死的 'file:///talos-plugin/main.js'——POSIX 上碰巧合法，
// 但 Windows 的 file URL 必须带盘符，createRequire(import.meta.url) 在客户
// Windows 机器上加载即抛 TypeError（2026-07-21 客户实测定位）。
// 现优先用真实 __filename 计算；拿不到时按平台给合法占位（仅作占位，
// SDK 始终显式传 pathToClaudeCodeExecutable，不靠它解析真实路径）。
var __talosImportMetaUrl = (() => {
	try {
		if (typeof __filename === "string" && __filename) {
			return require("node:url").pathToFileURL(__filename).href;
		}
	} catch (_e) { /* fall through */ }
	try {
		return typeof process !== "undefined" && process.platform === "win32"
			? "file:///C:/talos-plugin/main.js"
			: "file:///talos-plugin/main.js";
	} catch (_e) {
		return "file:///talos-plugin/main.js";
	}
})();
`;

const prod = process.argv[2] === 'production';

const shared = {
	banner: {
		js: banner,
	},
	bundle: true,
	external: [
		'obsidian',
		'electron',
		'@codemirror/autocomplete',
		'@codemirror/collab',
		'@codemirror/commands',
		'@codemirror/language',
		'@codemirror/lint',
		'@codemirror/search',
		'@codemirror/state',
		'@codemirror/view',
		'@lezer/common',
		'@lezer/highlight',
		'@lezer/lr',
		...builtinModules,
		...builtinModules.map((m) => `node:${m}`),
	],
	format: 'cjs',
	// claude-agent-sdk 顶层调用 createRequire(import.meta.url)；cjs 打包下 import.meta.url
	// 会变 undefined 导致加载即崩。指向 banner 里的运行时 shim（跨平台安全，
	// 写死 POSIX 假 URL 会让 Windows 加载即崩——见 banner 注释）。
	define: {
		'import.meta.url': '__talosImportMetaUrl',
	},
	target: 'es2021',
	logLevel: 'info',
	sourcemap: prod ? false : 'inline',
	treeShaking: true,
	minify: prod,
};

// TT 1.1.0:claude-agent-sdk 与独立 claude-sdk.cjs bundle 已随 Claude 运行时移除,
// 只保留单一 main.js 入口(sdk-node-timers-shim 同步删除)。
const context = await esbuild.context({
	...shared,
	entryPoints: ['src/main.ts'],
	plugins: [staticVendorText],
	outfile: 'main.js',
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
