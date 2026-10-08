import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 共用下拉（@ 文件、/ 命令、MCP 菜单）的可见性合同：Claudian 视觉 ABI 默认 display:none，
// 只认 .visible；只切 hidden 属性时下拉永远不会出现（2026-10-08 真机发现）。
const root = fileURLToPath(new URL("../", import.meta.url));
const composer = readFileSync(`${root}src/agent-workbench/ui/native-composer.ts`, "utf8");
const css = readFileSync(`${root}src/agent-workbench/ui/styles/features/file-context.css`, "utf8");

describe("composer dropdown visibility", () => {
	it("is shown by the .visible class in the stylesheet", () => {
		expect(css).toMatch(/\.claudian-mention-dropdown \{[^}]*display: none;/);
		expect(css).toMatch(/\.claudian-mention-dropdown\.visible \{[^}]*display: block;/);
	});

	it("toggles the hidden attribute and the visible class together in one place", () => {
		expect(composer).toMatch(/private setDropdownVisible\(visible: boolean\): void \{\s*this\.dropdown\.hidden = !visible;\s*this\.dropdown\.classList\.toggle\("visible", visible\);/);
		expect(composer.match(/this\.dropdown\.hidden =/g)).toHaveLength(1);
		expect(composer.match(/this\.setDropdownVisible\(/g)?.length).toBeGreaterThanOrEqual(4);
	});
});
