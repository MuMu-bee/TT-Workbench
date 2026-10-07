import { describe, expect, it, vi } from "vitest";
import { pageCommands, registerPageCommands } from "../src/plugin/page-commands";
import { PRIMARY_NAVIGATION } from "../src/ui/navigation-model";

describe("page commands", () => {
	it("registers one command per navigable page except pages that already have one", () => {
		const keys = PRIMARY_NAVIGATION.flatMap((group) => group.children.map((child) => child.key)).filter((key) => key !== "chat");
		expect(pageCommands().map((command) => command.pageKey)).toEqual(keys);
		expect(new Set(pageCommands().map((command) => command.id)).size).toBe(keys.length);
	});

	it("names commands by page and group so the palette search finds either", () => {
		const byKey = Object.fromEntries(pageCommands().map((command) => [command.pageKey, command.name]));
		expect(byKey.inbox).toBe("打开收件箱（内容流）");
		expect(byKey.today).toBe("打开今日");
		expect(byKey.settings).toBe("打开设置");
	});

	it("opens the matching page when a command runs", () => {
		const commands: Array<{ id: string; callback: () => void }> = [];
		const open = vi.fn(async () => undefined);
		registerPageCommands({ addCommand: (command) => commands.push(command) }, open);
		commands.find((command) => command.id === "open-page-health")?.callback();
		expect(open).toHaveBeenCalledWith("health");
	});
});
