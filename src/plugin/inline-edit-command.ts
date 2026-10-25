// 编辑器内的行内编辑入口：命令（可绑快捷键）与编辑器右键菜单。
// 复用 agent-workbench 的共用核心，确认后仅在选区未变化时替换。
import { Modal, Notice, type App, type Editor, type Menu } from "obsidian";
import { DEFAULT_INLINE_INSTRUCTION, renderInlineDiff, requestInlineReplacement, type InlineEditService } from "../agent-workbench/ui/inline-edit";

interface InlineEditHost {
	app: App;
	addCommand(command: { id: string; name: string; editorCheckCallback: (checking: boolean, editor: Editor) => boolean | void }): unknown;
	registerEvent(ref: ReturnType<App["workspace"]["on"]>): void;
	waitForAgentWorkbench(): Promise<{ service: InlineEditService }>;
}

class InlineEditModal extends Modal {
	private instruction!: HTMLTextAreaElement;
	private preview!: HTMLElement;
	private applyButton!: HTMLButtonElement;
	private generateButton!: HTMLButtonElement;
	private replacement: string | null = null;

	constructor(
		app: App,
		private readonly editor: Editor,
		private readonly original: string,
		private readonly service: () => Promise<InlineEditService>,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("TT 行内编辑");
		this.modalEl.addClass("talos-inline-edit-modal");
		this.instruction = this.contentEl.createEl("textarea", {
			cls: "claudian-inline-input",
			attr: { rows: "3", "aria-label": "修改要求", placeholder: DEFAULT_INLINE_INSTRUCTION },
		});
		this.preview = this.contentEl.createDiv({ cls: "claudian-inline-diff-preview" });
		this.preview.hidden = true;
		const actions = this.contentEl.createDiv({ cls: "claudian-inline-preview-actions" });
		this.generateButton = actions.createEl("button", { text: "生成", cls: "mod-cta" });
		this.applyButton = actions.createEl("button", { text: "应用" });
		this.applyButton.disabled = true;
		actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
		this.generateButton.addEventListener("click", () => void this.generate());
		this.applyButton.addEventListener("click", () => this.apply());
		this.instruction.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void this.generate(); }
		});
		this.instruction.focus();
	}

	private async generate(): Promise<void> {
		this.generateButton.disabled = true;
		this.applyButton.disabled = true;
		this.preview.hidden = false;
		this.preview.setText("正在生成…");
		try {
			this.replacement = await requestInlineReplacement(await this.service(), this.original, this.instruction.value);
			this.preview.empty();
			renderInlineDiff(this.preview.createDiv({ cls: "claudian-inline-diff-preview-body" }), this.original, this.replacement);
			this.applyButton.disabled = false;
		} catch (error) {
			this.replacement = null;
			this.preview.setText(`生成失败：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.generateButton.disabled = false;
			this.generateButton.setText("重新生成");
		}
	}

	private apply(): void {
		if (this.replacement === null) return;
		if (this.editor.getSelection() !== this.original) {
			new Notice("编辑器选区已变化，未应用替换");
			return;
		}
		this.editor.replaceSelection(this.replacement);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function openInlineEdit(host: InlineEditHost, editor: Editor): void {
	const original = editor.getSelection();
	if (!original.trim()) {
		new Notice("请先选中要修改的文字");
		return;
	}
	new InlineEditModal(host.app, editor, original, async () => (await host.waitForAgentWorkbench()).service).open();
}

export function registerInlineEditCommand(host: InlineEditHost): void {
	host.addCommand({
		id: "inline-edit-selection",
		name: "行内编辑选区",
		editorCheckCallback: (checking, editor) => {
			if (!editor.getSelection().trim()) return false;
			if (!checking) openInlineEdit(host, editor);
			return true;
		},
	});
	host.registerEvent(host.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
		if (!editor.getSelection().trim()) return;
		menu.addItem((item) => item
			.setTitle("TT 行内编辑")
			.setIcon("wand-sparkles")
			.onClick(() => openInlineEdit(host, editor)));
	}));
}
