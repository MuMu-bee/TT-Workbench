// Vault 内 Claude Code 项目命令（.claude/commands/**/*.md）的补全清单。
// 只在本机读取文件名与 frontmatter description 用于下拉提示，不外发；命令本身由
// Claude 运行时原生展开，其他运行时会把它当普通文本发送，因此标注适用运行时。

export const PROJECT_COMMAND_DIR = ".claude/commands";
const MAX_COMMANDS = 60;
const MAX_DEPTH = 3;

export interface ProjectCommand {
	value: string;
	label: string;
}

export interface CommandListingAdapter {
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
	read(path: string): Promise<string>;
}

/** frontmatter 里的 description；没有时取正文第一行非标题文字。 */
export function commandDescription(markdown: string): string {
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
	const described = frontmatter && /^description:\s*["']?(.+?)["']?\s*$/m.exec(frontmatter[1]);
	if (described) return described[1].trim();
	const body = frontmatter ? markdown.slice(frontmatter[0].length) : markdown;
	const line = body.split(/\r?\n/).map((item) => item.replace(/^#+\s*/, "").trim()).find(Boolean);
	return line ?? "";
}

export async function discoverProjectCommands(adapter: CommandListingAdapter): Promise<ProjectCommand[]> {
	const found: string[] = [];
	const walk = async (dir: string, depth: number): Promise<void> => {
		if (depth > MAX_DEPTH || found.length >= MAX_COMMANDS) return;
		let listing: { files: string[]; folders: string[] };
		try { listing = await adapter.list(dir); }
		catch { return; }
		for (const file of listing.files.filter((path) => path.endsWith(".md")).sort()) {
			if (found.length >= MAX_COMMANDS) break;
			found.push(file);
		}
		for (const folder of listing.folders.sort()) await walk(folder, depth + 1);
	};
	await walk(PROJECT_COMMAND_DIR, 0);

	const seen = new Set<string>();
	const commands: ProjectCommand[] = [];
	for (const path of found) {
		const name = path.slice(path.lastIndexOf("/") + 1, -".md".length);
		if (!/^[\w.-]+$/.test(name) || seen.has(name)) continue;
		seen.add(name);
		let description = "";
		try { description = commandDescription(await adapter.read(path)); }
		catch { /* 读不到描述时仍列出命令名 */ }
		commands.push({ value: `/${name}`, label: `${description || "项目命令"} · Claude` });
	}
	return commands;
}
