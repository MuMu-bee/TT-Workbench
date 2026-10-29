type Listener = (event: {
	key?: string;
	preventDefault(): void;
	stopPropagation(): void;
}) => void;

class MiniClassList {
	constructor(private readonly element: MiniElement) {}

	add(...tokens: string[]): void {
		const next = new Set(this.element.className.split(/\s+/).filter(Boolean));
		for (const token of tokens) next.add(token);
		this.element.className = Array.from(next).join(" ");
	}

	remove(...tokens: string[]): void {
		const removed = new Set(tokens);
		this.element.className = this.element.className
			.split(/\s+/)
			.filter((token) => token && !removed.has(token))
			.join(" ");
	}

	toggle(token: string, force?: boolean): boolean {
		const has = this.contains(token);
		const enabled = force ?? !has;
		if (enabled) this.add(token);
		else this.remove(token);
		return enabled;
	}

	contains(token: string): boolean {
		return this.element.className.split(/\s+/).includes(token);
	}
}

export class MiniStyle {
	readonly props: Record<string, string> = {};

	setProperty(name: string, value: string): void {
		this.props[name] = value;
	}

	getPropertyValue(name: string): string {
		return this.props[name] ?? "";
	}
}

export interface MiniElementOptions {
	cls?: string;
	text?: string;
	attr?: Record<string, string>;
}

export class MiniElement {
	readonly children: MiniElement[] = [];
	readonly attributes = new Map<string, string>();
	readonly dataset: Record<string, string> = {};
	readonly classList = new MiniClassList(this);
	readonly listeners = new Map<string, Listener[]>();
	/** Obsidian 的 HTMLElement.style；voice-panel 用 setProperty 写 --tq-state/--tq-spd。 */
	readonly style = new MiniStyle();
	className = "";
	disabled = false;
	hidden = false;
	type = "";
	value = "";
	/** 可控的连接状态（真实 DOM 的 Node.isConnected）；默认视为已挂载。 */
	isConnected = true;
	/** Document.createElementNS 建出来的元素带命名空间；createElement 为 null。 */
	namespaceURI: string | null = null;
	parentElement: MiniElement | null = null;
	private ownText = "";

	constructor(
		readonly tagName: string,
		readonly ownerDocument: MiniDocument
	) {}

	get textContent(): string {
		return this.ownText + this.children.map((child) => child.textContent).join("");
	}

	set textContent(value: string) {
		this.replaceChildren();
		this.ownText = value;
	}

	appendChild(child: MiniElement): MiniElement {
		child.parentElement = this;
		this.children.push(child);
		return child;
	}

	/** 追加一段纯文本（等价于 append(string)）；Obsidian 的 HTMLElement.appendText。 */
	appendText(text: string): void {
		this.ownText += text;
	}

	/** 子「元素」数量（不含文本节点）；对应 DOM 的 childElementCount。 */
	get childElementCount(): number {
		return this.children.length;
	}

	append(...nodes: Array<MiniElement | string>): void {
		for (const node of nodes) {
			if (typeof node === "string") {
				this.ownText += node;
			} else {
				this.appendChild(node);
			}
		}
	}

	replaceChildren(...children: MiniElement[]): void {
		for (const child of this.children) child.parentElement = null;
		this.children.splice(0, this.children.length);
		this.ownText = "";
		for (const child of children) this.appendChild(child);
	}

	// ---------- Obsidian 的 HTMLElement 扩展（面板/组件直接调用） ----------

	/** Obsidian: 清空所有子节点。 */
	empty(): void {
		this.replaceChildren();
	}

	/** Obsidian: 创建并挂一个子元素，支持 { cls, text, attr }。 */
	createEl(tag: string, options?: MiniElementOptions | string): MiniElement {
		const info = typeof options === "string" ? { cls: options } : options ?? {};
		const child = this.ownerDocument.createElement(tag);
		if (info.cls) child.className = info.cls;
		if (info.text !== undefined) child.textContent = info.text;
		for (const [name, value] of Object.entries(info.attr ?? {})) {
			child.setAttribute(name, value);
		}
		return this.appendChild(child);
	}

	createDiv(options?: MiniElementOptions | string): MiniElement {
		return this.createEl("div", options);
	}

	createSpan(options?: MiniElementOptions | string): MiniElement {
		return this.createEl("span", options);
	}

	/** Obsidian: 覆盖文本内容（不重建子结构以外的状态）。 */
	setText(text: string): void {
		this.textContent = text;
	}

	/** Obsidian: 写 CSS 自定义属性。 */
	setCssProps(props: Record<string, string>): void {
		for (const [name, value] of Object.entries(props)) this.style.setProperty(name, value);
	}

	addClass(...classes: string[]): void {
		this.classList.add(...classes);
	}

	removeClass(...classes: string[]): void {
		this.classList.remove(...classes);
	}

	toggleClass(cls: string, value?: boolean): void {
		this.classList.toggle(cls, value);
	}

	get firstElementChild(): MiniElement | null {
		return this.children[0] ?? null;
	}

	/** 真实 DOM 的 Element.closest：从自身开始沿父链找匹配的后代选择器。 */
	closest(selector: string): MiniElement | null {
		if (this.matches(selector)) return this;
		let cursor = this.parentElement;
		while (cursor) {
			if (cursor.matches(selector)) return cursor;
			cursor = cursor.parentElement;
		}
		return null;
	}

	scrollTop = 0;
	scrollHeight = 0;

	remove(): void {
		if (!this.parentElement) return;
		const index = this.parentElement.children.indexOf(this);
		if (index >= 0) this.parentElement.children.splice(index, 1);
		this.parentElement = null;
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
		if (name === "class") this.className = value;
		if (name.startsWith("data-")) {
			const key = name
				.slice(5)
				.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
			this.dataset[key] = value;
		}
	}

	getAttribute(name: string): string | null {
		if (name === "class") return this.className || null;
		return this.attributes.get(name) ?? null;
	}

	removeAttribute(name: string): void {
		this.attributes.delete(name);
		if (name === "class") this.className = "";
		if (name.startsWith("data-")) {
			const key = name
				.slice(5)
				.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
			delete this.dataset[key];
		}
	}

	addEventListener(type: string, listener: Listener): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	dispatch(type: string, key?: string): void {
		const event = {
			key,
			preventDefault() {},
			stopPropagation() {},
		};
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}

	click(): void {
		if (!this.disabled) this.dispatch("click");
	}

	querySelector<T = MiniElement>(selector: string): T | null {
		return (this.querySelectorAll(selector)[0] as T | undefined) ?? null;
	}

	querySelectorAll<T = MiniElement>(selector: string): T[] {
		const matches: MiniElement[] = [];
		const visit = (element: MiniElement) => {
			for (const child of element.children) {
				if (child.matches(selector)) matches.push(child);
				visit(child);
			}
		};
		visit(this);
		return matches as T[];
	}

	matches(selector: string): boolean {
		const attribute = selector.match(
			/^(?:(\w+))?\[([^=\]]+)=["']([^"']+)["']\]$/
		);
		if (attribute) {
			const [, tag, name, value] = attribute;
			return (
				(!tag || this.tagName === tag.toLowerCase()) &&
				this.getAttribute(name) === value
			);
		}
		if (selector.startsWith(".")) {
			return this.classList.contains(selector.slice(1));
		}
		return this.tagName === selector.toLowerCase();
	}
}

/** 文本节点：只有文本，永不匹配任何选择器（真实 DOM 的 Text 也没有 matches）。 */
class MiniTextNode extends MiniElement {
	constructor(ownerDocument: MiniDocument) {
		super("#text", ownerDocument);
	}

	matches(): boolean {
		return false;
	}
}

/** MiniDocument.defaultView：真实 DOM 的 window；只提供面板实际用到的成员。 */
export interface MiniWindow {
	matchMedia?(query: string): {
		matches: boolean;
		addEventListener?(): void;
		removeEventListener?(): void;
	};
	getComputedStyle?(element: MiniElement): { getPropertyValue(name: string): string };
	requestAnimationFrame?(callback: (time: number) => void): number;
	cancelAnimationFrame?(handle: number): void;
	MutationObserver?: new (callback: () => void) => {
		observe(): void;
		disconnect(): void;
	};
}

export class MiniDocument {
	readonly body: MiniElement;
	readonly documentElement: MiniElement;
	defaultView: MiniWindow | null = null;
	hidden = false;
	visibilityState: "visible" | "hidden" = "visible";
	activeElement: MiniElement | null = null;
	readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

	constructor() {
		this.documentElement = this.createElement("html");
		this.body = this.createElement("body");
		this.documentElement.appendChild(this.body);
	}

	createElement(tagName: string): MiniElement {
		return new MiniElement(tagName.toLowerCase(), this);
	}

	/**
	 * 真实 DOM 的 Document.createElementNS（SVG 元素）。
	 *
	 * `context-usage.ts:109` 用 `doc.createElementNS(SVG_NS, "svg")` 画上下文用量环；
	 * 没有这个方法，任何要构造 NativeComposer 的用例都会在构造期直接抛 TypeError。
	 * Mini DOM 不区分命名空间，只把 `namespaceURI` 记下来供断言。
	 */
	createElementNS(namespaceURI: string, tagName: string): MiniElement {
		const element = new MiniElement(tagName.toLowerCase(), this);
		element.namespaceURI = namespaceURI;
		return element;
	}

	/** 真实 DOM 的 Document.createTextNode；Lens 与部分组件用它塞纯字符串。 */
	createTextNode(text: string): MiniElement {
		const node = new MiniTextNode(this);
		node.textContent = text;
		return node;
	}

	addEventListener(type: string, listener: (...args: unknown[]) => void): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: (...args: unknown[]) => void): void {
		const listeners = this.listeners.get(type);
		if (!listeners) return;
		const index = listeners.indexOf(listener);
		if (index >= 0) listeners.splice(index, 1);
	}
}

export function createMiniHost(): {
	host: HTMLElement;
	element: MiniElement;
} {
	const document = new MiniDocument();
	const element = document.createElement("div");
	return {
		host: element as unknown as HTMLElement,
		element,
	};
}
