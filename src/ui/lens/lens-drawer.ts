// Lens 右侧摘要栏（v-document-drawer）：点击笔记卡片后从右侧打开，列表仍可操作。
// 摘要只做本地提取：优先 frontmatter 的 summary/description，否则取正文首段；
// 要点取二、三级标题。不调用外部模型、不保存正文副本；只有最新一次请求能更新面板。
import { TFile, type App } from "obsidian";
import { button, chip, el, fact, icon } from "./lens-dom";
import { bytes, time } from "./lens-format";

interface NoteSummary {
	text: string;
	method: "existing" | "structured" | "local";
	highlights: string[];
}

export function summarizeMarkdown(markdown: string, frontmatter: Record<string, unknown> | undefined, headings: string[]): NoteSummary | null {
	const existing = [frontmatter?.summary, frontmatter?.description].find((value) => typeof value === "string" && value.trim());
	const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
	const paragraph = body.split(/\r?\n\s*\r?\n/)
		.map((block) => block.trim())
		.find((block) => block && !/^(#|>|\||```|!\[|- \[|\* \[)/.test(block));
	const highlights = headings.slice(0, 5);
	if (typeof existing === "string") return { text: existing.trim(), method: "existing", highlights };
	if (paragraph) {
		const clean = paragraph.replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, target: string, alias: string) => alias || target).replace(/[*_`]/g, "");
		return { text: clean.length > 220 ? `${clean.slice(0, 220)}…` : clean, method: "local", highlights };
	}
	if (highlights.length) return { text: "这份笔记以标题结构为主。", method: "structured", highlights };
	return null;
}

export class LensDrawer {
	readonly pane: HTMLElement;
	private selected: string | null = null;
	private sequence = 0;
	private disposed = false;

	constructor(
		private readonly app: App,
		private readonly root: HTMLElement,
		windowEl: HTMLElement,
		private readonly onOpenNote: (path: string, newTab: boolean) => void,
	) {
		const doc = root.ownerDocument;
		this.pane = el(doc, "aside", { class: "v-document-drawer", "aria-label": "资料摘要", "aria-hidden": "true" });
		this.pane.inert = true;
		windowEl.appendChild(this.pane);
		doc.addEventListener("keydown", this.onKey);
	}

	get selectedPath(): string | null {
		return this.selected;
	}

	private shell(content: Node[], title: string, source: string): void {
		const doc = this.pane.ownerDocument;
		const close = el(doc, "button", { type: "button", class: "v-drawer-close", "aria-label": "关闭资料摘要" }, icon(doc, "x"));
		close.addEventListener("click", () => this.close());
		this.pane.replaceChildren(
			el(doc, "header", { class: "v-drawer-header" },
				el(doc, "div", {}, el(doc, "small", {}, source), el(doc, "h2", { tabindex: "-1" }, title)),
				close),
			el(doc, "div", { class: "v-drawer-content" }, ...content),
		);
	}

	async open(path: string): Promise<void> {
		if (this.disposed) return;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		const token = ++this.sequence;
		this.selected = path;
		this.pane.inert = false;
		this.pane.setAttribute("aria-hidden", "false");
		this.pane.dataset.open = "true";
		this.root.classList.add("has-document-drawer");
		this.markSelection();
		const doc = this.pane.ownerDocument;
		const source = `${file.parent?.path || "库根目录"} · ${file.extension}`;
		this.shell([el(doc, "div", { class: "v-summary-loading", role: "status" }, el(doc, "span"), el(doc, "p", {}, "正在提取内容摘要…"))], file.basename, source);
		const markdown = await this.app.vault.cachedRead(file);
		if (this.disposed || token !== this.sequence) return;
		const cache = this.app.metadataCache.getFileCache(file);
		const headings = (cache?.headings ?? []).filter((h) => h.level >= 2 && h.level <= 3).map((h) => h.heading);
		const summary = summarizeMarkdown(markdown, cache?.frontmatter, headings);
		const tags = [...new Set((cache?.tags ?? []).map((t) => t.tag.replace(/^#/, "")))];
		const methodLabel = summary?.method === "existing" ? "已有摘要" : summary?.method === "structured" ? "结构提要" : "本地提取";

		const summarySection = el(doc, "section", { class: "v-summary-section" },
			el(doc, "div", { class: "v-summary-heading" }, el(doc, "h3", {}, "内容摘要"), summary ? chip(doc, methodLabel, "dim") : null),
			summary
				? el(doc, "p", { class: "v-summary-lead" }, summary.text)
				: el(doc, "div", { class: "v-summary-empty" }, icon(doc, "file-text"), el(doc, "p", {}, "这份笔记暂时没有可提取的正文。")),
			summary && summary.highlights.length ? el(doc, "h4", {}, "关键要点") : null,
			summary && summary.highlights.length ? el(doc, "ul", { class: "v-summary-points" }, ...summary.highlights.map((h) => el(doc, "li", {}, h))) : null,
			el(doc, "div", { class: "v-summary-provenance" },
				summary ? el(doc, "span", {}, `依据：${summary.method === "existing" ? "frontmatter 摘要" : summary.method === "structured" ? "标题结构" : "正文首段"}`) : null,
				el(doc, "span", {}, `提取时间 ${time(Date.now())}`)),
		);
		const openNote = button(doc, "打开笔记", {}, true);
		openNote.addEventListener("click", () => this.onOpenNote(path, false));
		const openTab = button(doc, "在新标签页打开");
		openTab.addEventListener("click", () => this.onOpenNote(path, true));
		const metadata = el(doc, "details", { class: "v-drawer-metadata" },
			el(doc, "summary", {}, "文件信息", el(doc, "span", {}, bytes(file.stat.size))),
			el(doc, "div", { class: "v-drawer-metadata-body" },
				fact(doc, "位置", el(doc, "span", { class: "ta-mono" }, file.path)),
				fact(doc, "修改时间", time(file.stat.mtime)),
				tags.length ? fact(doc, "已有标签", el(doc, "span", {}, ...tags.map((t) => chip(doc, t, "dim")))) : null,
				fact(doc, "引用目标", String(cache?.links?.length ?? 0))),
		);
		this.shell([summarySection, el(doc, "div", { class: "v-drawer-actions" }, openNote, openTab), metadata], file.basename, source);
	}

	close(): void {
		if (!this.selected) return;
		this.selected = null;
		this.sequence++;
		this.pane.dataset.open = "false";
		this.pane.setAttribute("aria-hidden", "true");
		this.pane.inert = true;
		this.root.classList.remove("has-document-drawer");
		this.markSelection();
	}

	/** 卡片上的选中态跟随摘要栏。 */
	markSelection(): void {
		for (const card of Array.from(this.root.querySelectorAll<HTMLElement>("[data-doc]"))) {
			card.classList.toggle("is-selected", card.dataset.doc === this.selected);
		}
	}

	private onKey = (event: KeyboardEvent): void => {
		if (event.key === "Escape" && this.selected && this.root.isConnected) {
			event.preventDefault();
			this.close();
		}
	};

	dispose(): void {
		this.disposed = true;
		this.sequence++;
		this.pane.ownerDocument.removeEventListener("keydown", this.onKey);
		this.pane.remove();
	}
}
