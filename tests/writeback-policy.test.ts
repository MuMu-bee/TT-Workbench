import { describe, expect, it } from "vitest";
import { proposeAnswerWriteback } from "../src/ai/writeback-policy";
import { resolveSchema } from "../src/data/schema";

// 回写目录由 schema 派生（不再写死旧目录名）。
const folders = (() => {
	const schema = resolveSchema(undefined);
	return { insights: schema.insights, output: schema.output };
})();

describe("answer writeback policy", () => {
	it("does not write answers by default", () => {
		expect(
			proposeAnswerWriteback(
				{
					intent: "display-only",
					title: "回答",
					content: "正文",
				},
				folders
			)
		).toBeNull();
	});

	it("routes knowledge conclusions to 30 洞察 as an approval proposal", () => {
		const proposal = proposeAnswerWriteback(
			{
				intent: "knowledge",
				title: "Provider 结论",
				content: "正文",
			},
			folders
		);
		expect(proposal).toMatchObject({
			targetPath: "02-洞察/Provider 结论.md",
			risk: "B",
			approvalRequired: true,
		});
		expect(proposal?.diffPreview).toContain("+正文");
	});

	it("routes deliverables to 70 输出 and sanitizes the filename", () => {
		expect(
			proposeAnswerWriteback(
				{
					intent: "output",
					title: "../产品/草案",
					content: "交付正文",
				},
				folders
			)
		).toMatchObject({
			targetPath: "输出/产品-草案.md",
			risk: "B",
			approvalRequired: true,
		});
	});
});
