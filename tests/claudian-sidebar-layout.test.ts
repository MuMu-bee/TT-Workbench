import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 右侧边栏 Claudian 同构布局（2026-10-08）：顶部只留标识与状态，会话标签在输入框上方，
// 模型 / 思考在底栏左侧，工作流 / 授权在右侧，运行时与认证方式并入模型下拉。
const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");
const workbench = read("src/agent-workbench/ui/talos-agent-workbench.ts");
const view = read("src/agent-workbench/ui/native-conversation-view.ts");
const composer = read("src/agent-workbench/ui/native-composer.ts");
const css = read("styles.ui-v2.css");
const sidebarCss = css.slice(css.indexOf("右侧边栏 · Claudian 同构布局"));

describe("Claudian-style sidebar layout", () => {
	it("orders the composer as queue, nav row, then the bordered input with its toolbar", () => {
		const queue = composer.indexOf('queueRow.className = "claudian-input-queue-row"');
		const nav = composer.indexOf('navRow.className = "claudian-input-nav-row"');
		const wrapper = composer.indexOf('wrapper.className = "claudian-input-wrapper"');
		expect(queue).toBeGreaterThan(-1);
		expect(nav).toBeGreaterThan(queue);
		expect(wrapper).toBeGreaterThan(nav);
		expect(composer).toContain("wrapper.appendChild(contextRow);");
		expect(composer).toContain("toolbar.append(leading, this.contextMeter.el, left, spacer, trailing, submit);");
	});

	it("puts session tabs and the new / history actions above the input", () => {
		expect(view).toContain("composer.navRow.append(tabRow, headerActions);");
		expect(view).toContain('this.headerButton(doc, "square-plus", "新建会话"');
		expect(view).toContain('this.headerButton(doc, "history", "会话历史"');
		expect(view).not.toContain("root.appendChild(tabRow);");
	});

	it("keeps only the title and runtime status in the header", () => {
		expect(workbench).toContain('header.className = "claudian-header talos-agent-header"');
		expect(workbench).toContain('titleText.textContent = "TT"');
		expect(workbench).toContain("headerStatus.appendChild(status);");
		expect(workbench).not.toContain('className = "talos-agent-controls"');
	});

	it("moves model, thinking, workflow and permission into the composer toolbar", () => {
		for (const control of ["modelControl", "reasoningControl", "serviceTierControl"]) {
			expect(workbench).toContain(`leadingControls.push(${control});`);
		}
		for (const control of ["workflow", "permissionControl"]) {
			expect(workbench).toContain(`trailingControls.push(${control});`);
		}
		expect(workbench).toContain("this.placeToolbarControls();");
		expect(workbench).toContain("menuRuntime.append(runtimeSwitcher, provider);");
	});

	it("opens menus upward and keeps the three permission levels", () => {
		expect(sidebarCss).toMatch(/:is\(\.talos-agent-model-menu, \.talos-agent-permission-menu\) \{[^}]*bottom: calc\(100% \+ 6px\);/);
		expect(workbench).toContain('for (const mode of ["ask", "scoped", "vault-full"] as const)');
	});

	it("sends on Enter like Claudian and only shows the stop button while streaming", () => {
		expect(sidebarCss).toContain(".talos-native-composer:not(.is-streaming) .claudian-submit-btn");
		expect(composer).toContain('this.root.classList.toggle("is-streaming", busy);');
	});
});
