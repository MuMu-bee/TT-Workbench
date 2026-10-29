// Lens 界面语言的 DOM 构造工具。结构与类名逐一对照 TALOS Lens 的模板字符串，
// 但全部用 createElement 生成（不拼接 innerHTML），样式来自同步的 styles.lens.css。
import { setIcon } from "obsidian";

export type LensChild = Node | string | number | null | undefined | false;
export type LensAttrs = Record<string, string | number | boolean | null | undefined>;

/** 防抖句柄：run 推迟执行、flush 立刻执行待处理调用、cancel 丢弃待处理调用。 */
export interface Debounced {
	run(): void;
	flush(): void;
	cancel(): void;
}

/**
 * 极简防抖（Q-PER9）：搜索框每个字符都会触发一次整页重建，先合并成一个窗口再渲染。
 *
 * 定时器来源不能写 `window.setTimeout`：Lens 的用例跑在 node 下，那里没有 `window`
 * （本会话实测 `node -e "typeof window"` 为 undefined），照抄 native-composer.ts 的写法
 * 会让任何用例在第一次输入时直接抛错。取全局对象本身（不是它上面的方法），
 * 所以 vitest 的 `vi.useFakeTimers()` 运行时替换 setTimeout 仍然生效。
 * 唯一一处全局对象引用，按仓库既有做法逐行豁免 obsidianmd/no-global-this。
 */
// eslint-disable-next-line obsidianmd/no-global-this -- 需要 node（测试）与 Obsidian 都能用；见上方注释
const globalTimers: Pick<Window, "setTimeout" | "clearTimeout"> = globalThis;

export function debounce(fn: () => void, waitMs: number): Debounced {
	let handle: ReturnType<Window["setTimeout"]> | null = null;
	const cancel = (): void => {
		if (handle === null) return;
		globalTimers.clearTimeout(handle);
		handle = null;
	};
	const invoke = (): void => {
		cancel();
		fn();
	};
	return {
		run(): void {
			cancel();
			handle = globalTimers.setTimeout(invoke, waitMs);
		},
		flush(): void {
			if (handle === null) return;
			invoke();
		},
		cancel,
	};
}

export function el<K extends keyof HTMLElementTagNameMap>(
	doc: Document,
	tag: K,
	attrs: LensAttrs = {},
	...children: LensChild[]
): HTMLElementTagNameMap[K] {
	const node = doc.createElement(tag);
	for (const [key, value] of Object.entries(attrs)) {
		if (value === null || value === undefined || value === false) continue;
		if (key === "class") node.className = String(value);
		else if (key === "style") node.setAttribute("style", String(value));
		else node.setAttribute(key, value === true ? "" : String(value));
	}
	append(node, children);
	return node;
}

export function append(parent: Node, children: LensChild[]): void {
	const doc = parent.ownerDocument ?? (parent as Document);
	for (const child of children) {
		if (child === null || child === undefined || child === false) continue;
		parent.appendChild(typeof child === "string" || typeof child === "number" ? doc.createTextNode(String(child)) : child);
	}
}

/**
 * Lens 用 lucide createIcons 把 <i data-lucide> 换成 17×17、描边 2 的 svg。
 * 这里用 Obsidian 内置的同一套 lucide 图标，去掉 svg-icon 类（避免 Obsidian 的图标尺寸规则），
 * 换成 lucide 的类名与尺寸属性，渲染结果与 Lens 一致。
 */
export function icon(doc: Document, name: string): Element {
	const host = doc.createElement("span");
	setIcon(host, name);
	const svg = host.querySelector("svg");
	if (!svg) return doc.createTextNode("") as unknown as Element;
	svg.removeAttribute("class");
	svg.setAttribute("class", `lucide lucide-${name}`);
	svg.setAttribute("width", "17");
	svg.setAttribute("height", "17");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("aria-hidden", "true");
	return svg;
}

export function chip(doc: Document, text: string, tone = ""): HTMLElement {
	return el(doc, "span", { class: "ta-chip", "data-tone": tone }, text);
}

export function button(doc: Document, text: LensChild, attrs: LensAttrs = {}, primary = false): HTMLButtonElement {
	return el(doc, "button", { type: "button", class: `ta-button${primary ? " ta-primary" : ""}`, ...attrs }, text);
}

export function link(doc: Document, text: string, onClick: () => void, attrs: LensAttrs = {}): HTMLButtonElement {
	const node = el(doc, "button", { type: "button", class: "ta-link", ...attrs }, text, icon(doc, "arrow-up-right"));
	node.addEventListener("click", onClick);
	return node;
}

export function fact(doc: Document, label: string, value: LensChild): HTMLElement {
	return el(doc, "div", { class: "ta-fact" }, el(doc, "span", {}, label), el(doc, "span", {}, value));
}

export function section(doc: Document, title: string, body: LensChild[], action?: LensChild): HTMLElement {
	return el(doc, "section", { class: "ta-section" },
		el(doc, "div", { class: "ta-section-head" }, el(doc, "h2", {}, title), action),
		...body);
}

export function panel(doc: Document, title: string, body: LensChild[], action?: LensChild): HTMLElement {
	return el(doc, "section", { class: "v-panel" },
		el(doc, "div", { class: "v-panel-head" }, el(doc, "h2", {}, title), action),
		...body);
}

/** 页面标题：子页显示所属分组小字，标题 + 副标题，右侧可放操作。 */
export function heading(doc: Document, title: string, subtitle = "", context = "", action?: LensChild): HTMLElement {
	return el(doc, "div", { class: "ta-heading" },
		el(doc, "div", {},
			context ? el(doc, "span", { class: "lens-page-context" }, context) : null,
			el(doc, "div", { class: "lens-page-title" }, el(doc, "h1", {}, title)),
			subtitle ? el(doc, "small", {}, subtitle) : null),
		action);
}

/** 单值比例条（visual-kit meter）。 */
export function meter(doc: Document, value: number, max: number, tone = "idle"): HTMLElement {
	const width = max > 0 ? Math.max(value > 0 ? 4 : 0, Math.round((value / max) * 100)) : 0;
	return el(doc, "span", { class: "vk-meter", "aria-hidden": "true" },
		el(doc, "span", { "data-tone": tone, style: `--vk-w:${width}%` }));
}
