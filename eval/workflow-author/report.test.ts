import { describe, expect, it } from "vitest";
import { formatAuthorEval } from "./report.ts";
import type { AuthorEvalResult } from "./scorer.ts";

function result(input: Partial<AuthorEvalResult> & Pick<AuthorEvalResult, "model" | "score">): AuthorEvalResult {
	return {
		caseId: "S1",
		caseName: "single-file bugfix",
		variant: "semantic-no-read",
		passed: input.score >= 0.7,
		notes: [],
		script: "export const meta = {};",
		metrics: {
			workflowSize: "small",
			primarySteps: 2,
			agentCountEstimate: 2,
			lowLevelControlCount: 0,
			usesKinds: ["implement", "testChange"],
			hasReview: false,
			hasTest: true,
			hasHumanGate: false,
			usesParallel: false,
			usesRawAgent: false,
			usesRawPipeline: false,
			workflowSizeFit: true,
			projectAgnostic: true,
		},
		...input,
	};
}

describe("workflow author report", () => {
	it("formats model comparison metrics", () => {
		const report = formatAuthorEval([
			result({ model: "xiaomi/mimo-v2.5-pro", score: 0.82 }),
			result({ model: "openai-codex:gpt-5.4", score: 0.91 }),
		]);

		expect(report).toContain("semantic-no-read model winner: openai-codex:gpt-5.4 Δ=0.090");
		expect(report).toContain("Model Summary:");
		expect(report).toContain("xiaomi/mimo-v2.5-pro");
		expect(report).toContain("openai-codex:gpt-5.4");
		expect(report).toContain("sizeFit=1/1");
	});
});
