import { readFileSync } from "node:fs";
import { expectSourceContains } from "./helpers/source-text";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const composer = readFileSync(`${root}src/agent-workbench/ui/native-composer.ts`, "utf8");
const preflight = readFileSync(`${root}src/ai/privacy/chat-provider-egress-preflight.ts`, "utf8");
const css = readFileSync(`${root}src/agent-workbench/ui/styles/components/input.css`, "utf8");

describe("composer image gate", () => {
	it("keeps the image entry closed exactly while the egress preflight still blocks images", () => {
		const blocked = /export const IMAGE_INPUT_BLOCKED_REASON: string \| null = "[^"]+";/.test(composer);
		const preflightBlocks = preflight.includes('if (input.hasImages) extraReasons.push("image-egress-not-audited");');
		expect(blocked).toBe(preflightBlocks);
	});

	it("routes the button, paste and drop through the same gate", () => {
		expectSourceContains("src/agent-workbench/ui/native-composer.ts", "this.imageButton(),");
		expect(composer.match(/this\.acceptImages\(images\)/g)).toHaveLength(2);
		expect(composer).not.toMatch(/void this\.addImages\(images\)\s*;\s*\}\s*\)\s*;/);
		expectSourceContains("src/agent-workbench/ui/native-composer.ts", "new Notice(IMAGE_INPUT_BLOCKED_REASON)");
	});

	it("shows the unavailable state instead of a live-looking button", () => {
		expectSourceContains("src/agent-workbench/ui/native-composer.ts", "button.disabled = true;");
		expect(css).toMatch(/\.claudian-input-nav-btn:disabled,\s*\.claudian-input-nav-btn\.is-unavailable \{[^}]*cursor: not-allowed;/);
	});
});
