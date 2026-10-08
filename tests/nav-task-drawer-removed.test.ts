import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { viewSource } from "./helpers/source-text";

// 2026-10-08：左侧导航不再挂「任务」抽屉；后台任务运行时与今日页的任务进度保持不变。
const root = fileURLToPath(new URL("../", import.meta.url));

describe("navigation without the task drawer", () => {
	it("no longer mounts or ships the drawer", () => {
		expect(viewSource()).not.toContain("TaskDrawer");
		expect(existsSync(`${root}src/ui/task-drawer.ts`)).toBe(false);
		for (const sheet of ["styles.talos.css", "styles.layout-overrides.css", "styles.ui-v2.css"]) {
			expect(readFileSync(`${root}${sheet}`, "utf8")).not.toContain("talos-task-drawer");
		}
	});

	it("keeps the console action runtime that the today page uses", () => {
		expect(viewSource()).toContain("getConsoleActionRuntime()");
	});
});
