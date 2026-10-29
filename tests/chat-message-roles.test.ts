import { readFileSync } from "node:fs";
import { expectSourceContains } from "./helpers/source-text";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 对话内容区分用户与回复：角色标签 + 两种气泡样式（仅作用于右侧边栏）。
const root = fileURLToPath(new URL("../", import.meta.url));
const renderer = readFileSync(`${root}src/agent-workbench/ui/native-event-renderer.ts`, "utf8");
const css = readFileSync(`${root}styles.ui-v2.css`, "utf8");
const block = css.slice(css.indexOf("对话内容区分用户与回复"));

describe("chat message roles", () => {
	it("labels user messages and replies, with the reply's runtime", () => {
		expectSourceContains("src/agent-workbench/ui/native-event-renderer.ts", 'message.replaceChildren(this.roleLabel(message.ownerDocument, "user"));');
		expectSourceContains("src/agent-workbench/ui/native-event-renderer.ts", 'message.appendChild(this.roleLabel(message.ownerDocument, "assistant", runtimeId));');
		expect(renderer.match(/this\.ensureAssistant\(event\.turnId, event\.runtimeId\)/g)).toHaveLength(2);
		expectSourceContains("src/agent-workbench/ui/native-event-renderer.ts", 'label.textContent = "你";');
		expectSourceContains("src/agent-workbench/ui/native-event-renderer.ts", 'name.textContent = "TT";');
		expectSourceContains("src/agent-workbench/ui/native-event-renderer.ts", 'label.setAttribute("aria-hidden", "true");');
	});

	it("styles the user as a right-aligned tinted bubble and the reply as full-width text", () => {
		expect(block).toMatch(/\.claudian-message-user \{[^}]*align-self: flex-end;[^}]*max-width: 85%;/);
		expect(block).toMatch(/\.claudian-message-user \.claudian-message-content \{[^}]*background: color-mix\(in srgb, var\(--talos-sb-brand\) 12%/);
		expect(block).toMatch(/\.claudian-message-assistant \{[^}]*background: transparent;/);
		expect(block).toMatch(/\.claudian-messages \{[^}]*gap: 18px;/);
	});
});
