import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ setIcon: vi.fn() }));
vi.mock("../src/actions", () => ({ openFile: vi.fn() }));
vi.mock("../src/ui/console-action-panel", () => ({ ConsoleActionPanel: class {} }));
vi.mock("../src/ui/quick-note", () => ({ QuickNote: class {} }));

import { pickTodaySlots, type TodayTimelineSlot } from "../src/ui/pages/today-page";

const slot = (time: string, mins: number, dur: number): TodayTimelineSlot => ({
	time,
	mins,
	dur,
	title: time,
	starter: "",
	path: `${time}.md`,
});

const slots = [slot("08:30", 510, 15), slot("09:00", 540, 120), slot("14:00", 840, 120)];

describe("today page timeline", () => {
	it("returns the running slot and the next one", () => {
		const picked = pickTodaySlots(slots, 600);
		expect(picked.current?.time).toBe("09:00");
		expect(picked.next?.time).toBe("14:00");
	});

	it("has no current slot in a gap but still points to the next block", () => {
		const picked = pickTodaySlots(slots, 700);
		expect(picked.current).toBeNull();
		expect(picked.next?.time).toBe("14:00");
	});

	it("treats a slot's end minute as finished", () => {
		expect(pickTodaySlots(slots, 525).current).toBeNull();
	});

	it("reports nothing after the last block", () => {
		expect(pickTodaySlots(slots, 1200)).toEqual({ current: null, next: null });
	});
});
