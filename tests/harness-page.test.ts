import { describe, expect, it } from "vitest";
import { primaryPage, resolvePageRoute } from "../src/ui/navigation-model";
import { viewSource } from "./helpers/source-text";

// DeepSeek Harness 独立成「助手」组的第三个标签页，沿用原对话页的整屏布局。
describe("harness page", () => {
	it("is reachable from the assistant group and by its old channel id", () => {
		expect(primaryPage("assistant").children.map((child) => child.key)).toContain("harness");
		expect(resolvePageRoute("harness")).toEqual({ primary: "assistant", secondary: "harness" });
		expect(resolvePageRoute("dsh")).toEqual({ primary: "assistant", secondary: "harness" });
	});

	it("keeps the full-screen chat layout and mounts only on its own page", () => {
		const view = viewSource();
		expect(view).toContain('if (this.activePage === "harness") this.contentEl.classList.add("section-chat");');
		expect(view).toContain('if (this.activePage === "harness" && this.chatMounted) return;');
		expect(view).toContain('if (view.activePage !== "harness") {');
	});
});
