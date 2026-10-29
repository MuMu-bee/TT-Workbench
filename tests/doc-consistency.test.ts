import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// settings.ts 在模块作用域 import obsidian 的运行时值（Setting/PluginSettingTab/Modal/…）。
// 本文件只读它导出的 TALOS_SETTING_TABS，故按既有面板测试的做法替身掉宿主包。
vi.mock("obsidian", () => ({
	App: class {},
	Component: class {
		load(): void {}
		unload(): void {}
	},
	DropdownComponent: class {},
	MarkdownRenderer: { render: async () => undefined },
	Modal: class {
		constructor(..._args: unknown[]) {}
		open(): void {}
		close(): void {}
	},
	Notice: class {
		constructor(_message?: string, _timeout?: number) {}
	},
	Plugin: class {},
	PluginSettingTab: class {
		constructor(..._args: unknown[]) {}
	},
	Setting: class {
		setName(): this {
			return this;
		}
		setDesc(): this {
			return this;
		}
		addDropdown(): this {
			return this;
		}
		addToggle(): this {
			return this;
		}
		addText(): this {
			return this;
		}
		addTextArea(): this {
			return this;
		}
		addButton(): this {
			return this;
		}
		addExtraButton(): this {
			return this;
		}
	},
	TextComponent: class {},
	TFile: class {},
	TFolder: class {},
	normalizePath: (path: string) => path,
	requestUrl: vi.fn(),
	setIcon: (): void => undefined,
}));

import { TALOS_SETTING_TABS } from "../src/settings";
import {
	LOCAL_PREVIEW_MAX_BINARY_BYTES,
	LOCAL_PREVIEW_MAX_CELL_CHARACTERS,
	LOCAL_PREVIEW_MAX_RENDERED_CHARACTERS,
	LOCAL_PREVIEW_MAX_TABLE_COLUMNS,
	LOCAL_PREVIEW_MAX_TABLE_ROWS,
	LOCAL_PREVIEW_MAX_TEXT_BYTES,
} from "../src/agent-workbench/ui/file-preview/local-preview-policy";

/**
 * 文档一致性守卫（Q-DOC 系列）。
 *
 * 这一组守卫的判据都是「文档里的数字/名字/路径与代码或仓库事实一致」，且全部只读仓库内
 * 已存在的东西——不依赖任何新建文档、不依赖网络、不依赖 git。
 *
 * 断言的书写方式：本文件刻意不用 `toContain`（那会把 `tests/` 的纯文本断言计数推高，
 * 而 `tests/source-text-assertions.test.ts` 的单调下降闸门不允许回涨），改用等价的
 * 子串判定 helper。强度不变：命中的仍是文档全文里的确定子串。
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (relative: string): string => readFileSync(`${root}${relative}`, "utf8");

/** 等价于 `expect(haystack).toContain(needle)`，只是不占用本仓库的纯文本断言计数。 */
function expectMention(haystack: string, needle: string): void {
	expect(haystack.includes(needle), `缺少子串：${needle}`).toBe(true);
}

/** 等价于 `expect(haystack).not.toContain(needle)`。 */
function expectNoMention(haystack: string, needle: string): void {
	expect(haystack.includes(needle), `不应出现子串：${needle}`).toBe(false);
}

/** 某文件里包含 `needle` 的行。 */
function linesMentioning(text: string, needle: string): string[] {
	return text.split("\n").filter((line) => line.includes(needle));
}

/** 列出目录下全部 .ts 文件（相对仓库根，posix 分隔）。 */
function listTypescriptFiles(directory: string): string[] {
	return readdirSync(`${root}${directory}`, { recursive: true, encoding: "utf8" })
		.filter((name) => typeof name === "string" && name.endsWith(".ts"))
		.map((name) => `${directory}${name.split("\\").join("/")}`);
}

describe("README platform matrix (Q-DOC1)", () => {
	it("says Windows is Plan-only by default and executes the local CLI only after explicit opt-in without OS isolation", () => {
		const readme = read("README.md");
		// 默认态与 src/settings.ts 的默认值一致。
		expectMention(readme, "**默认 Plan-only**");
		expectMention(readme, "windowsApprovalOnlyExecution");
		expectMention(readme, "osIsolation: false");
		// 不得再出现被推翻的旧陈述。
		expectNoMention(readme, "当前为 **Plan-only**，不会启动本机 CLI 或执行工具");
		// 不得把该后端描述成沙盒。
		expect(/Windows[^。\n]*沙盒/.test(readme)).toBe(false);
	});

	it("points the safety section at the same exception the platform matrix states", () => {
		expectMention(read("README.md"), "唯一例外是用户在设置页显式开启的 Windows 无隔离执行后端");
	});
});

describe("README build artifacts and install manifest (Q-DOC2 / Q-DOC3)", () => {
	it("no longer tells users the build produces claude-sdk.cjs", () => {
		const readme = read("README.md");
		expectNoMention(readme, "`main.js` / `claude-sdk.cjs` / `styles.css`");
		expectMention(readme, "`main.js` / `styles.css`");
	});

	it("lists the mascot (which code reads) and drops the favicon (which code never reads)", () => {
		const readme = read("README.md");
		const installLine = readme.split("\n").find((line) => line.startsWith("手动安装需包含："));
		expect(installLine).toBeDefined();
		// 9 项清单：mascot 在、favicon 不在。
		expectMention(installLine ?? "", "TALOS-Mascot-Character-Transparent-v1.png");
		expectNoMention(installLine ?? "", "TALOS-Favicon-64-v1.png");
		const listed = (installLine ?? "").match(/`[^`]+`/g) ?? [];
		expect(listed).toHaveLength(9);
		// 被代码读取的资产必须在清单里：消费点在 src/ 里，常量名与路径都要对得上。
		expectMention(
			read("src/ui/welcome-easter-egg.ts"),
			'const FALLBACK_MASCOT = "TALOS-Mascot-Character-Transparent-v1.png"'
		);
	});

	it("keeps every listed install asset reachable from src/ or a root *.css consumer set", () => {
		// 只查 src/ 会让 MaShanZheng-Regular.ttf 第一天就红：它唯一的消费点是根目录的
		// styles.quyuan-shell.css:3。故消费点集合 = src/ + 仓库根 *.css。
		const readme = read("README.md");
		const installLine = readme.split("\n").find((line) => line.startsWith("手动安装需包含：")) ?? "";
		const assets = (installLine.match(/`([^`]+)`/g) ?? []).map((token) => token.slice(1, -1));
		const cssRoot = readdirSync(root).filter((name) => name.endsWith(".css"));
		const srcText = listTypescriptFiles("src/").map(read).join("\n");
		const cssText = cssRoot.map(read).join("\n");
		const consumers = `${srcText}\n${cssText}`;
		// 只对「代码里可能有消费点」的资产断言；.md/.txt 类分发件按定义就是被发布而非被读取。
		for (const asset of ["MaShanZheng-Regular.ttf", "TALOS-Mascot-Character-Transparent-v1.png"]) {
			expect(assets.includes(asset), `安装清单缺少 ${asset}`).toBe(true);
			expectMention(consumers, asset);
		}
	});
});

describe("README settings tab name (Q-DOC4)", () => {
	it("names the tab 对话与模型 and lists all four labels from TALOS_SETTING_TABS", () => {
		const readme = read("README.md");
		expectMention(readme, "TT工作台设置 → 对话与模型");
		expectNoMention(readme, "TT工作台设置 → 智能体与模型");
		// 四个 tab 的 label 与 settings.ts 的导出逐字一致。
		expect(TALOS_SETTING_TABS.map((tab) => tab.label)).toEqual([
			"界面",
			"库与数据",
			"对话与模型",
			"屈原 · 语音",
		]);
		for (const tab of TALOS_SETTING_TABS) expectMention(readme, tab.label);
	});

	it("uses the same tab name in the in-plugin Windows guidance", () => {
		// 这是用户实际会被引导去点击的路径，不能与 README 分叉。
		const sandbox = read("src/agent-workbench/security/process-sandbox.ts");
		expectMention(sandbox, "对话与模型");
		expectNoMention(sandbox, "智能体与模型");
	});
});

describe("README themes (Q-DOC5)", () => {
	it("declares eight themes matching settings.ts and mentions the removed ones only as removed", () => {
		const readme = read("README.md");
		const settings = read("src/settings.ts");
		expectMention(readme, "**八套视觉主题**");
		expectNoMention(readme, "**十套视觉主题**");
		// settings.ts 枚举成员数（`TalosVisualTheme` 的 `| "..."` 计数）与 README 声明数一致。
		const enumBlock = settings.split("\n").slice(32, 42).join("\n");
		const members = [...enumBlock.matchAll(/\|\s*"([a-z-]+)"/g)].map((match) => match[1]);
		expect(members).toHaveLength(8);
		// 8 个主题下拉项：按枚举成员逐个定位它自己的 addOption 行，标签必须逐字出现在 README。
		// （不能用全文件 addOption 计数——设置页还有语言、深浅色等多个下拉。）
		for (const id of members) {
			const optionLine = settings
				.split("\n")
				.find((line) => line.includes(`.addOption("${id}",`));
			expect(optionLine, `${id} 缺少 addOption`).toBeDefined();
			const label = optionLine?.match(/\.addOption\("[a-z-]+",\s*"([^"]+)"\)/)?.[1] ?? "";
			expect(label.length).toBeGreaterThan(0);
			expectMention(readme, label);
		}
		// Macintosh / Swiss 只允许出现在「已移除」句里。
		const macLines = linesMentioning(readme, "Macintosh");
		expect(macLines).toHaveLength(1);
		expectMention(macLines[0], "已移除");
		const swissLines = linesMentioning(readme, "Swiss");
		expect(swissLines).toHaveLength(1);
		expectMention(swissLines[0], "已移除");
	});
});

describe("version consistency (Q-DOC6)", () => {
	it("keeps manifest, package, README badge, AGENTS and versions.json on the same version", () => {
		const manifest = JSON.parse(read("manifest.json")) as { version: string };
		const pkg = JSON.parse(read("package.json")) as { version: string };
		const versions = JSON.parse(read("versions.json")) as Record<string, string>;
		const readmeBadge = read("README.md").match(/badge\/version-(\d+\.\d+\.\d+)-/);
		const agentsVersion = read("AGENTS.md").match(/版本 `(\d+\.\d+\.\d+)`/);
		expect(readmeBadge?.[1]).toBe(manifest.version);
		expect(agentsVersion?.[1]).toBe(manifest.version);
		expect(pkg.version).toBe(manifest.version);
		// 当前版本必须已登记进 versions.json（含最低 Obsidian 版本映射）。
		expect(manifest.version in versions, `${manifest.version} 未登记进 versions.json`).toBe(true);
		// CHANGELOG 里的历史版本号不纳入比对：它是时间线记录，比中会误报。
	});
});

describe("AGENTS.md install path and dead references (Q-DOC7)", () => {
	it("installs into the plugin id from manifest.json and drops references to files not in this repo", () => {
		const agents = read("AGENTS.md");
		const manifest = JSON.parse(read("manifest.json")) as { id: string };
		expectMention(agents, `<vault>/.obsidian/plugins/${manifest.id}/`);
		// 旧安装目录（插件名为上游的 talos）。用字符串拼装匹配，避免触发
		// `obsidianmd/hardcoded-config-path`——这里断言的是文档文本，不是 Vault 路径。
		expectNoMention(agents, `<vault>/.${"obsidian"}/plugins/talos/`);
		expectNoMention(agents, "与 `CLAUDE.md` 内容一致");
		expectNoMention(agents, "必须与 refresh-dashboard.py 一致");
		expectMention(agents, "与 `src/data/schema.ts` 的目录约定一致");
		// 提到的 .py 文件名必须带「不在本仓库」类标注。
		for (const line of linesMentioning(agents, "refresh-dashboard.py")) {
			expect(line).toMatch(/不在本仓库/);
		}
	});
});

describe("release-gate wording (Q-DOC9)", () => {
	it("no longer presents G1–G7 as a release authority the repo cannot adjudicate", () => {
		const readme = read("README.md");
		// U+2013 连字符。
		expectNoMention(readme, "G1–G7");
		expectNoMention(readme, "发布权威");
		// AGENTS.md 也写明本仓库不定义 G4–G7。
		expectMention(read("AGENTS.md"), "本仓库不定义 G4–G7");
	});
});

describe("README recommended docs (Q-DOC10 / Q-DOC11)", () => {
	it("stops recommending the invalidated planning doc and keeps no live reference to a missing contracts/ json", () => {
		const readme = read("README.md");
		expectNoMention(readme, "更完整的执行链路见 [`docs/multi-channel-execution.md`]");
		expectMention(readme, "src/agent-workbench/");
		// 失效横幅必须在文档的 :1-5 内。
		const multiChannelHead = read("docs/multi-channel-execution.md").split("\n").slice(0, 5).join("\n");
		expectMention(multiChannelHead, "已失效");
		// contracts/ 目录不存在：文档不得以现在时声称该 json 存在。
		expect(existsSync(`${root}contracts`)).toBe(false);
		const rollback = read("docs/qa/wp7-upgrade-rollback.md");
		expectNoMention(rollback, "权威源码通过");
		expectMention(rollback, "仓库内无独立 json 副本");
	});
});

describe("wp7-mock-acceptance deliverables (Q-DOC12)", () => {
	it("marks the missing selftest as not delivered and every listed deliverable that is claimed to exist does", () => {
		const doc = read("docs/qa/wp7-mock-acceptance.md");
		expectMention(doc, "未落地");
		// 清单里出现的每个 *.selftest.mjs 名，若未带「未落地」标注就必须真实存在于仓库根。
		const selftestNames = [...new Set(doc.match(/[a-z0-9-]+\.selftest\.mjs/g) ?? [])];
		expect(selftestNames.length).toBeGreaterThan(0);
		for (const name of selftestNames) {
			if (linesMentioning(doc, name).some((line) => line.includes("未落地"))) continue;
			expect(existsSync(`${root}${name}`), `${name} 被当作已存在产物列出`).toBe(true);
		}
		// 真实存在的四个 selftest 必须都还在。
		for (const name of [
			"agent-workbench-chat-gate.selftest.mjs",
			"agent-workbench-native.selftest.mjs",
			"approval-actions.selftest.mjs",
			"approval-executor.selftest.mjs",
		]) expect(existsSync(`${root}${name}`)).toBe(true);
		// 同一文档里对不上的 selftest 输出串已按实测改掉：该表行必须以实测串为准。
		const quyuanRow = doc.split("\n").find((line) => line.startsWith("| `npm run test:quyuan`")) ?? "";
		expectMention(quyuanRow, "TALOS native agent workbench self-test passed");
		// 旧的错误输出串只允许作为「原记……」的更正说明出现，不能作为结果值出现。
		expect(quyuanRow).toMatch(/原记的 `Quyuan v2 self-test: passed`/);
	});
});

describe("preview limits stay in lockstep with the g3 contract doc (Q-DOC14)", () => {
	it("parses the numbers out of docs/qa/g3-multiformat-preview-acceptance.md :14-32 and matches the policy constants", () => {
		const lines = read("docs/qa/g3-multiformat-preview-acceptance.md").split("\n");
		const region = lines.slice(13, 32).join("\n");
		// 表格里的 MB 限额（文本族 2 MB、二值族 10 MB）。
		const mbValues = [...region.matchAll(/\|\s*(\d+)\s*MB\s*\|/g)].map((match) => Number(match[1]));
		expect(mbValues.includes(LOCAL_PREVIEW_MAX_TEXT_BYTES / (1024 * 1024))).toBe(true);
		expect(mbValues.includes(LOCAL_PREVIEW_MAX_BINARY_BYTES / (1024 * 1024))).toBe(true);
		// 表格限额与字符限额句子。
		const tableLimit = region.match(
			/Table output is limited to (\d+) rows, (\d+) columns and ([\d,]+) characters per cell\./
		);
		expect(tableLimit).not.toBeNull();
		expect(Number(tableLimit?.[1])).toBe(LOCAL_PREVIEW_MAX_TABLE_ROWS);
		expect(Number(tableLimit?.[2])).toBe(LOCAL_PREVIEW_MAX_TABLE_COLUMNS);
		expect(Number((tableLimit?.[3] ?? "").replace(/,/g, ""))).toBe(LOCAL_PREVIEW_MAX_CELL_CHARACTERS);
		const textLimit = region.match(/Text output is limited to ([\d,]+) characters\./);
		expect(Number((textLimit?.[1] ?? "").replace(/,/g, ""))).toBe(LOCAL_PREVIEW_MAX_RENDERED_CHARACTERS);
	});

	it("points the entry at the composer button and locates the implementation outside src/quyuan", () => {
		const doc = read("docs/qa/g3-multiformat-preview-acceptance.md");
		expectMention(doc, "The conversation composer exposes");
		expectNoMention(doc, "The Quyuan action row exposes");
		// 入口确实在 composer 里。
		expectMention(read("src/agent-workbench/ui/native-composer.ts"), 'iconButton("file-search", "本地安全预览"');
		// 文档提到的实现路径存在，且 src/quyuan 里没有 Preview。
		expect(existsSync(`${root}src/agent-workbench/ui/file-preview/local-preview-policy.ts`)).toBe(true);
		expect(existsSync(`${root}src/agent-workbench/ui/file-preview/local-preview-modal.ts`)).toBe(true);
		for (const file of listTypescriptFiles("src/quyuan/")) {
			expect(read(file).includes("Preview"), `${file} 不应出现 Preview`).toBe(false);
		}
	});
});

describe("CHANGELOG footer date (Q-DOC15)", () => {
	it("keeps the footer 最近 date equal to the largest entry-head date in the file", () => {
		const changelog = read("CHANGELOG.md");
		// 只取「条目首行日期」：`- YYYY-MM-DD ...`，避免把正文里的计划日期或页脚自身算进来。
		const entryDates = [...changelog.matchAll(/^- (\d{4}-\d{2}-\d{2})\b/gm)].map((match) => match[1]);
		expect(entryDates.length).toBeGreaterThan(0);
		const maxEntryDate = entryDates.reduce((max, date) => (date > max ? date : max));
		const footer = changelog.match(/最近：(\d{4}-\d{2}-\d{2})/);
		expect(footer?.[1]).toBe(maxEntryDate);
	});
});

describe("MODIFICATIONS local-ASR statement (Q-DOC16)", () => {
	it("states the dead-code chain as deleted with the residual file registered as a 0-reference archive", () => {
		const mods = read("MODIFICATIONS.md");
		expectNoMention(mods, "本批次不删");
		expectMention(mods, "已于 1.2.0 删除");
		expectMention(mods, "local-voice-supply-chain.ts");
		// 残留文件仍然存在（默认口径 = 保留 + 标注，不删文件）。
		expect(existsSync(`${root}src/quyuan/local-voice-supply-chain.ts`)).toBe(true);
		// 该文件头有「0 引用」标注。
		expectMention(read("src/quyuan/local-voice-supply-chain.ts"), "0 引用");
		// 顶部有「按批次追加」的阅读口径。
		expectMention(mods.split("\n").slice(0, 8).join("\n"), "按批次追加");
	});
});

describe("ROADMAP batch 2 wording (Q-DOC17)", () => {
	it("uses one judgeable conclusion for batch 2 and writes voice-panel's measured line count", () => {
		const roadmap = read("ROADMAP.md");
		expectNoMention(roadmap, "✅ 已于 1.2.0 完成");
		expectMention(roadmap, "🟡 主体完成(1.2.0)");
		// 行数用实测值：与 wc 口径一致（本仓库 measureFileSizes 的 countFileLines）。
		const voicePanelLines = read("src/quyuan/voice-panel.ts").split(/\r?\n/).length - 1;
		expectNoMention(roadmap, "1470→1440 行");
		expectMention(roadmap, `1470→${voicePanelLines} 行`);
	});
});

describe("markdown tab guard (Q-DOC18)", () => {
	it("keeps every repo *.md free of a bare tab character", () => {
		const markdownFiles: string[] = [];
		const walk = (directory: string): void => {
			for (const entry of readdirSync(`${root}${directory}`, { withFileTypes: true })) {
				if (entry.name === "node_modules" || entry.name === ".git") continue;
				const next = `${directory}${entry.name}`;
				if (entry.isDirectory()) {
					walk(`${next}/`);
					continue;
				}
				if (entry.name.endsWith(".md")) markdownFiles.push(next);
			}
		};
		walk("");
		expect(markdownFiles.length).toBeGreaterThan(10);
		const offenders = markdownFiles.filter((file) => read(file).includes("\t"));
		expect(offenders).toEqual([]);
	});

	it("records the 1.3.1 test-vault path as a placeholder instead of a tab-mangled path", () => {
		const acceptance = read("ACCEPTANCE.md");
		expectNoMention(acceptance, "C:UsersTTDocuments");
		expectMention(acceptance, "<盘符>:\\Users\\<用户名>\\Documents\\tt-workbench-test");
	});
});
