// 笔记写入白名单的唯一真源：只从 TalosVaultSchema 派生，不再有第二、第三个字面量。
// 纯函数模块：只做类型导入，不依赖 obsidian 运行时，单元测试可直接加载。
import type { TalosVaultSchema } from "../data/schema";

/** 允许 create-note 写入的模块根目录（按 schema 顺序去重）。 */
export function noteRootsFromSchema(schema: TalosVaultSchema): string[] {
	return Array.from(
		new Set([schema.inbox, schema.logs, schema.insights, schema.output])
	);
}

export interface NoteScopes {
	noteWriteScopes: string[];
	publishWriteScopes: string[];
}

/** 由 schema 派生出笔记写入与发布回填的影响范围。 */
export function noteScopesFromSchema(schema: TalosVaultSchema): NoteScopes {
	return {
		noteWriteScopes: noteRootsFromSchema(schema).map((root) => `${root}/**`),
		publishWriteScopes: ["<publish>", `${schema.output}/**`],
	};
}
