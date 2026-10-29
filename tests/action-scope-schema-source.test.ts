import { describe, expect, it, vi } from "vitest";
import {
	createBuiltinActionRegistry,
	type BuiltinActionDependencies,
} from "../src/action-core/builtin-actions";
import {
	noteRootsFromSchema,
	noteScopesFromSchema,
} from "../src/action-core/note-scopes";
import { evaluateActionRisk } from "../src/action-core/risk-policy";
import { resolveSchema } from "../src/data/schema";

const dependencies = (): BuiltinActionDependencies => ({
	refreshStats: vi.fn(),
	vaultLint: vi.fn(),
	deepResearch: vi.fn(),
	createNote: vi.fn(),
	publishBackfill: vi.fn(),
	decideApproval: vi.fn(),
	decidePreference: vi.fn(),
	moveInboxNote: vi.fn(),
});

function registryFromSchema() {
	return createBuiltinActionRegistry(
		dependencies(),
		noteScopesFromSchema(resolveSchema(undefined))
	);
}

function writeRequest(path: string) {
	return {
		readPaths: [],
		writePaths: [path],
		effects: ["write" as const],
	};
}

describe("note scopes derive from TalosVaultSchema", () => {
	it("derives four note roots from the schema and none of the legacy directories", () => {
		const roots = noteRootsFromSchema(resolveSchema(undefined));

		expect(roots).toEqual(["00-收件箱", "01-日志", "02-洞察", "输出"]);
		expect(roots).toHaveLength(4);
		// 旧目录字面量不再出现在白名单里（严格 toEqual 已覆盖，这里再显式钉住一次）
		expect(roots.filter((root) => ["00 收件箱", "01 日志", "30 洞察", "70 输出"].includes(root)))
			.toEqual([]);
	});

	it("derives note and publish scopes from the schema output directory", () => {
		const scopes = noteScopesFromSchema(resolveSchema(undefined));

		expect(scopes.noteWriteScopes).toEqual([
			"00-收件箱/**",
			"01-日志/**",
			"02-洞察/**",
			"输出/**",
		]);
		expect(scopes.publishWriteScopes).toEqual(["<publish>", "输出/**"]);
		// registry.ts:26 的「C 类必须有影响范围」校验仍通过（长度 2，非空）
		expect(scopes.publishWriteScopes).toHaveLength(2);
	});

	it("keeps schema-derived roots when the caller overrides the schema", () => {
		const scopes = noteScopesFromSchema(
			resolveSchema({ inbox: "Inbox", logs: "Logs", insights: "Notes", output: "Out" })
		);

		expect(scopes.noteWriteScopes).toEqual([
			"Inbox/**",
			"Logs/**",
			"Notes/**",
			"Out/**",
		]);
		expect(scopes.publishWriteScopes).toEqual(["<publish>", "Out/**"]);
	});

	it("lets schema directories run while legacy directories fall back to propose", () => {
		const create = registryFromSchema().get("create-note");
		if (!create) throw new Error("create-note 未注册");

		expect(evaluateActionRisk(create, writeRequest("02-洞察/x.md")).decision).toBe(
			"snapshot-and-run"
		);
		expect(evaluateActionRisk(create, writeRequest("输出/x.md")).decision).toBe(
			"snapshot-and-run"
		);
		// 旧目录不再被白名单放行
		expect(evaluateActionRisk(create, writeRequest("30 洞察/x.md")).decision).toBe(
			"propose"
		);
		expect(evaluateActionRisk(create, writeRequest("70 输出/x.md")).decision).toBe(
			"propose"
		);
	});

	it("derives the publish-backfill scope instead of hardcoding 70 输出", () => {
		const publish = registryFromSchema().get("publish-backfill");
		if (!publish) throw new Error("publish-backfill 未注册");

		expect(publish.writeScope).toEqual(["<publish>", "输出/**"]);
		// C 类在 risk-policy.ts:60 短路 propose，故此步只验证「字面量已消除」
		expect(evaluateActionRisk(publish, writeRequest("70 输出/x.md")).decision).toBe(
			"propose"
		);
	});
});
