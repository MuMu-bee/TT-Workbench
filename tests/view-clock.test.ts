import { describe, expect, it, vi } from "vitest";
import { clockText, paintClock, type ClockRefs } from "../src/ui/view-clock";
import { createObsidianHost, type ObsidianTestElement } from "./helpers/obsidian-dom";

function at(y: number, mo: number, day: number, h: number, mi: number, s: number): Date {
	return new Date(y, mo - 1, day, h, mi, s);
}

/**
 * 按 buildSidebar 里的真实结构建一次时钟：span:hh / em / span:mm / em / span:ss。
 * 之后 paintClock 只应对这 5 个节点（外加 date / cosmosClock）做 setText。
 * 返回的 nodes 保留具体测试元素类型，断言文本时不经过收窄后的 ClockRefs。
 */
function buildClock(): {
	container: ObsidianTestElement;
	refs: ClockRefs;
	nodes: {
		hh: ObsidianTestElement;
		mm: ObsidianTestElement;
		ss: ObsidianTestElement;
		date: ObsidianTestElement;
		cosmosClock: ObsidianTestElement;
	};
} {
	const { element } = createObsidianHost();
	const container = element.createDiv({ cls: "time" });
	const hh = container.createSpan({ cls: "clock-hh", text: "--" });
	container.createEl("em", { text: ":" });
	const mm = container.createSpan({ cls: "clock-mm", text: "--" });
	container.createEl("em", { text: ":" });
	const ss = container.createSpan({ cls: "clock-ss", text: "--" });
	const date = element.createDiv({ cls: "date" });
	const cosmosClock = element.createSpan({ cls: "cosmos-clock", text: "—" });
	return {
		container,
		refs: { hh, mm, ss, date, cosmosClock },
		nodes: { hh, mm, ss, date, cosmosClock },
	};
}

describe("clockText", () => {
	it("时分秒补零，日期行带星期", () => {
		const parts = clockText(at(2026, 7, 8, 9, 5, 3));
		expect(parts.hh).toBe("09");
		expect(parts.mm).toBe("05");
		expect(parts.ss).toBe("03");
		expect(parts.dateLine).toBe("2026-07-08\n周三");
		expect(parts.cosmosLine).toBe("2026-07-08 09:05:03");
	});

	it("午夜与跨日边界的补零", () => {
		const midnight = clockText(at(2026, 12, 31, 0, 0, 0));
		expect([midnight.hh, midnight.mm, midnight.ss]).toEqual(["00", "00", "00"]);
		expect(midnight.dateLine).toBe("2026-12-31\n周四");
		expect(midnight.cosmosLine).toBe("2026-12-31 00:00:00");

		const nextDay = clockText(at(2027, 1, 1, 23, 59, 59));
		expect([nextDay.hh, nextDay.mm, nextDay.ss]).toEqual(["23", "59", "59"]);
		expect(nextDay.dateLine).toBe("2027-01-01\n周五");
	});
});

describe("paintClock", () => {
	it("两次绘制都不创建节点，子节点数与引用保持不变", () => {
		const { container, refs } = buildClock();
		const before = [...container.children];
		expect(container.childElementCount).toBe(5);

		// 给容器的 createEl / createSpan / createDiv 包计数 spy：
		// 任一次 paintClock 里新建节点都会被抓到。
		const createEl = vi.spyOn(container, "createEl");
		const createSpan = vi.spyOn(container, "createSpan");
		const createDiv = vi.spyOn(container, "createDiv");

		paintClock(refs, clockText(at(2026, 7, 8, 9, 5, 3)));
		paintClock(refs, clockText(at(2026, 7, 8, 10, 6, 4)));

		expect(createEl).not.toHaveBeenCalled();
		expect(createSpan).not.toHaveBeenCalled();
		expect(createDiv).not.toHaveBeenCalled();
		expect(container.childElementCount).toBe(5);
		container.children.forEach((child, index) => {
			expect(child).toBe(before[index]);
		});
	});

	it("就地写入文本且保留冒号分隔符", () => {
		const { container, refs, nodes } = buildClock();
		paintClock(refs, clockText(at(2026, 7, 8, 9, 5, 3)));

		expect(nodes.hh.textContent).toBe("09");
		expect(nodes.mm.textContent).toBe("05");
		expect(nodes.ss.textContent).toBe("03");
		expect(nodes.date.textContent).toBe("2026-07-08\n周三");
		expect(nodes.cosmosClock.textContent).toBe("2026-07-08 09:05:03");
		// 5 个节点里两个 em 仍是冒号，文本整体形态不变
		expect(container.textContent).toBe("09:05:03");
	});

	it("cosmosClock 为 null 时不抛错（经典外壳之外没有该节点）", () => {
		const { refs, nodes } = buildClock();
		const withoutCosmos: ClockRefs = { ...refs, cosmosClock: null };
		expect(() => paintClock(withoutCosmos, clockText(at(2026, 7, 8, 9, 5, 3)))).not.toThrow();
		expect(nodes.hh.textContent).toBe("09");
	});
});
