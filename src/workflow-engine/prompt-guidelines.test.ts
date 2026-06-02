import { describe, expect, it } from "vitest";
import { WORKFLOW_AUTHOR_GUIDELINES, buildWorkflowAuthorPrompt } from "./prompt-guidelines.ts";

describe("workflow author prompt guidelines", () => {
	it("keeps the dynamic workflow surface generic", () => {
		const prompt = buildWorkflowAuthorPrompt("change code safely");

		expect(prompt).toContain("agent(prompt, opts)");
		expect(prompt).toContain("parallel(thunks)");
		expect(prompt).toContain("pipeline(items, ...stages)");
		expect(prompt).not.toContain("devAgent");
		expect(prompt).not.toContain("reviewAgent");
	});

	it("documents task complexity tiers and agent constraints", () => {
		const text = WORKFLOW_AUTHOR_GUIDELINES.join("\n");

		expect(text).toContain("simple (one function/CLI change");
		expect(text).toContain("medium (multi-file");
		expect(text).toContain("large (cross-module");
		expect(text).toContain("agentType: 'dev'");
		expect(text).toContain("agentType: 'review'");
		expect(text).toContain("isolation: 'worktree'");
		expect(text).toContain("task-scoped worktree");
		expect(text).toContain("loop back to dev once max");
		expect(text).toContain("Do not include line numbers");
	});
});
