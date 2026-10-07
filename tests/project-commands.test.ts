import { describe, expect, it } from "vitest";
import { commandDescription, discoverProjectCommands, type CommandListingAdapter } from "../src/agent-workbench/ui/project-commands";

function adapter(tree: Record<string, { files?: string[]; folders?: string[] }>, contents: Record<string, string>): CommandListingAdapter {
	return {
		list: async (path) => {
			const entry = tree[path];
			if (!entry) throw new Error(`missing ${path}`);
			return { files: entry.files ?? [], folders: entry.folders ?? [] };
		},
		read: async (path) => {
			if (!(path in contents)) throw new Error(`unreadable ${path}`);
			return contents[path];
		},
	};
}

describe("vault project slash commands", () => {
	it("lists .claude/commands markdown with frontmatter descriptions, including subfolders", async () => {
		const commands = await discoverProjectCommands(adapter({
			".claude/commands": { files: [".claude/commands/retrieval.md", ".claude/commands/intake.md.bak", ".claude/commands/brand.md"], folders: [".claude/commands/ops"] },
			".claude/commands/ops": { files: [".claude/commands/ops/weekly.md"] },
		}, {
			".claude/commands/retrieval.md": '---\ndescription: "知识检索与主动关联"\n---\n# /retrieval',
			".claude/commands/brand.md": "# 品牌审查\n正文",
			".claude/commands/ops/weekly.md": "",
		}));
		expect(commands).toEqual([
			{ value: "/brand", label: "品牌审查 · Claude" },
			{ value: "/retrieval", label: "知识检索与主动关联 · Claude" },
			{ value: "/weekly", label: "项目命令 · Claude" },
		]);
	});

	it("returns nothing when the vault has no command folder", async () => {
		expect(await discoverProjectCommands(adapter({}, {}))).toEqual([]);
	});

	it("skips duplicate or unsafe names and keeps listing when a file cannot be read", async () => {
		const commands = await discoverProjectCommands(adapter({
			".claude/commands": { files: [".claude/commands/a b.md", ".claude/commands/x.md"], folders: [".claude/commands/sub"] },
			".claude/commands/sub": { files: [".claude/commands/sub/x.md"] },
		}, {}));
		expect(commands).toEqual([{ value: "/x", label: "项目命令 · Claude" }]);
	});

	it("reads descriptions from frontmatter or the first body line", () => {
		expect(commandDescription("---\ndescription: 周复盘\nmodel: x\n---\n# 标题")).toBe("周复盘");
		expect(commandDescription("\n## 晨间简报\n内容")).toBe("晨间简报");
	});
});
