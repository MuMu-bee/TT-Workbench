import { MiniDocument, MiniElement, MiniStyle, type MiniElementOptions } from "./mini-dom";

// 在 MiniElement 上补齐 Obsidian 对 HTMLElement 的扩展（createDiv / createEl /
// setAttr / setCssProps …），用于直接渲染并断言控制台模块的真实 DOM 输出。
// 注意：MiniElement 现已自带 createDiv/createEl/createSpan/setText/setCssProps/style，
// 本类只做「额外的测试专用能力」（title / setAttr / all / one）+ 更宽松的 attr 值类型。

type ElementOptions = {
	cls?: string | string[];
	text?: string;
	attr?: Record<string, string | number | boolean | null>;
};

/** 把宽松的 ElementOptions 归一成 MiniElement 能接受的字面量形状。 */
function normalize(options: ElementOptions): MiniElementOptions {
	const attr: Record<string, string> = {};
	for (const [name, value] of Object.entries(options.attr ?? {})) {
		if (value === null || value === false) continue;
		attr[name] = String(value);
	}
	const cls = Array.isArray(options.cls) ? options.cls.join(" ") : options.cls;
	return {
		...(cls === undefined ? {} : { cls }),
		...(options.text === undefined ? {} : { text: options.text }),
		attr,
	};
}

/** MiniStyle 的测试侧别名；MiniElement.style 的类型就是它。 */
class TestStyle extends MiniStyle {
	width = "";
}

export class ObsidianTestElement extends MiniElement {
	override readonly style = new TestStyle();
	title = "";

	override createEl(tag: string, options: ElementOptions | string = {}): ObsidianTestElement {
		const info = typeof options === "string" ? { cls: options } : options;
		const element = new ObsidianTestElement(tag, this.ownerDocument);
		const normalized = normalize(info);
		if (normalized.cls) element.className = normalized.cls;
		if (normalized.text !== undefined) element.textContent = normalized.text;
		for (const [name, value] of Object.entries(normalized.attr ?? {})) {
			element.setAttribute(name, value);
		}
		this.appendChild(element);
		return element;
	}

	override createDiv(options?: ElementOptions | string): ObsidianTestElement {
		return this.createEl("div", options);
	}

	override createSpan(options?: ElementOptions | string): ObsidianTestElement {
		return this.createEl("span", options);
	}

	setAttr(name: string, value: string | number | boolean): void {
		this.setAttribute(name, String(value));
	}

	addClass(...classes: string[]): void {
		this.classList.add(...classes);
	}

	toggleClass(cls: string, value: boolean): void {
		this.classList.toggle(cls, value);
	}

	setCssProps(props: Record<string, string>): void {
		for (const [name, value] of Object.entries(props)) this.style.setProperty(name, value);
	}

	setText(text: string): void {
		this.textContent = text;
	}

	empty(): void {
		this.replaceChildren();
	}

	/** 按 class 查找全部后代（保持文档顺序）。 */
	all(cls: string): ObsidianTestElement[] {
		return this.querySelectorAll<ObsidianTestElement>(`.${cls}`);
	}

	one(cls: string): ObsidianTestElement {
		const found = this.querySelector<ObsidianTestElement>(`.${cls}`);
		if (!found) throw new Error(`missing .${cls}`);
		return found;
	}
}

export function createObsidianHost(): { host: HTMLElement; element: ObsidianTestElement } {
	const element = new ObsidianTestElement("div", new MiniDocument());
	return { host: element as unknown as HTMLElement, element };
}
