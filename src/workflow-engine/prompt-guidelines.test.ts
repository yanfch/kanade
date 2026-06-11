import { describe, expect, it } from "vitest";
import {
	LEGACY_WORKFLOW_AUTHOR_GUIDELINES,
	WORKFLOW_AUTHOR_GUIDELINES,
	buildLegacyWorkflowAuthorPrompt,
	buildWorkflowAuthorPrompt,
} from "./prompt-guidelines.ts";

describe("workflow author prompt guidelines", () => {
	it("uses semantic V1 helpers for the main authoring prompt", () => {
		const prompt = buildWorkflowAuthorPrompt("change code safely", { complexityHint: "medium" });

		expect(prompt).toContain("implement(prompt, opts)");
		expect(prompt).toContain("reviewChange(input, opts)");
		expect(prompt).toContain("continueImplementation(previous, opts)");
		expect(prompt).toContain("testChange(input, opts)");
		expect(prompt).toContain("request_human(request)");
		expect(prompt).toContain("helper options may include model");
		expect(prompt).toContain("Current task complexity hint: medium");
		expect(prompt).toContain("validation.status === 'failed'");
		expect(prompt).toContain("Fix validation");
		expect(prompt).toContain("warnings: { type: 'array'");
		expect(prompt).toContain("issues means blocking validation failures only");
		expect(prompt).toContain("Prefer validation commands inferred from workspace context");
		expect(prompt).toContain("Node/TypeScript: inspect package.json and run npm test");
		expect(prompt).toContain("Java/Maven: inspect pom.xml and run ./mvnw test or mvn test");
		expect(prompt).toContain("Python: inspect requirements files and run pytest");
		expect(prompt).toContain("Rust: inspect Cargo.toml and run cargo test");
		expect(prompt).toContain("Go: inspect go.mod and run go test ./...");
		expect(prompt).toContain("If no project check command can be confidently inferred");
		expect(prompt).toContain("If stack is unclear, use generic guidance such as 'Run relevant project checks'");
		expect(prompt).not.toContain("Available globals: agent(prompt, opts)");
		expect(prompt).not.toContain("compareCandidates(");
		expect(prompt).not.toContain("integrateChanges(");
		expect(prompt).not.toContain("summarize(");
	});

	it("forbids low-level execution details and custom iterate branches in the semantic prompt", () => {
		const text = WORKFLOW_AUTHOR_GUIDELINES.join("\n");

		expect(text).toContain("Do not choose branch names");
		expect(text).toContain("Do not use raw agent() or pipeline()");
		expect(text).toContain("kanade iterate uses a separate built-in refinement workflow");
		expect(text).toContain("parallel() is available, but in V1 use it only for bounded read-oriented fan-out");
		expect(text).toContain("feedback is required");
		expect(text).toContain("approved means no blocking issues");
		expect(text).toContain("If validation.status is failed");
		expect(text).toContain("non-blocking environment or retry notes in warnings");
	});

	it("keeps the legacy prompt available for eval comparisons", () => {
		const prompt = buildLegacyWorkflowAuthorPrompt("change code safely");
		const text = LEGACY_WORKFLOW_AUTHOR_GUIDELINES.join("\n");

		expect(prompt).toContain("agent(prompt, opts)");
		expect(prompt).toContain("pipeline(items, ...stages)");
		expect(text).toContain("agentType: 'dev'");
		expect(text).toContain("agentType: 'review'");
		expect(text).toContain("isolation: 'worktree'");
		expect(text).toContain("task-scoped worktree");
		expect(text).toContain("loop back to dev once max");
		expect(text).toContain("Do not include line numbers");
	});
});
