import { describe, expect, it } from "vitest";
import { buildIterateWorkflowScript } from "../server/iterate-workflow.ts";
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
		expect(prompt).toContain("Workspace profile snapshot");
		expect(prompt).toContain(
			"User instructions are authoritative; advisory profile suggestions may be overridden by explicit task instructions in the request.",
		);
		expect(prompt).toContain("The workspace profile snapshot provides concrete stack-aware command suggestions.");
		expect(prompt).toContain("If no project check command can be confidently inferred");
		expect(prompt).toContain("Use backtick template literals for multi-line prompt strings");
		expect(prompt).toContain("never include unescaped backticks");
		expect(prompt).toContain("If stack is unclear, use generic guidance such as 'Run relevant project checks'");
		expect(prompt).not.toContain("Available globals: agent(prompt, opts)");
		expect(prompt).not.toContain("compareCandidates(");
		expect(prompt).not.toContain("integrateChanges(");
		expect(prompt).not.toContain("summarize(");
	});

	it("omits the medium review-loop example for simple tasks", () => {
		const prompt = buildWorkflowAuthorPrompt("fix a typo", { complexityHint: "simple" });

		expect(prompt).toContain("Current task complexity hint: simple");
		expect(prompt).toContain("Example (simple task):");
		expect(prompt).toContain("fix_login_retry");
		expect(prompt).not.toContain("Example (medium task with review loop):");
		expect(prompt).not.toContain("refactor_workflow_author");
		expect(prompt).not.toContain("review.status === 'needs_fix'");
	});

	it("includes both examples for medium and complex tasks", () => {
		for (const hint of ["medium", "complex"] as const) {
			const prompt = buildWorkflowAuthorPrompt("do work", { complexityHint: hint });

			expect(prompt).toContain("Example (simple task):");
			expect(prompt).toContain("Example (medium task with review loop):");
			expect(prompt).toContain("fix_login_retry");
			expect(prompt).toContain("refactor_workflow_author");
		}
	});

	it("includes both examples when no complexity hint is provided", () => {
		const prompt = buildWorkflowAuthorPrompt("do work");

		expect(prompt).toContain("Example (simple task):");
		expect(prompt).toContain("Example (medium task with review loop):");
		expect(prompt).not.toContain("Current task complexity hint:");
	});

	it("always includes the stack-aware validation section", () => {
		for (const hint of [undefined, "simple", "medium", "complex"] as const) {
			const prompt = buildWorkflowAuthorPrompt("task", hint ? { complexityHint: hint } : undefined);

			expect(prompt).toContain("Stack-aware validation:");
			expect(prompt).toContain("workspace profile snapshot");
		}
	});

	it("always includes the iterate policy warning regardless of complexity", () => {
		for (const hint of [undefined, "simple", "medium", "complex"] as const) {
			const prompt = buildWorkflowAuthorPrompt("task", hint ? { complexityHint: hint } : undefined);

			expect(prompt).toContain("kanade iterate uses a separate built-in refinement workflow");
			expect(prompt).toContain("Do not author custom iterate branches");
		}
	});

	it("embeds the task prompt in the output", () => {
		const prompt = buildWorkflowAuthorPrompt("Add dark mode toggle to settings page");

		expect(prompt).toContain("Add dark mode toggle to settings page");
	});

	it("includes the output contract section", () => {
		const prompt = buildWorkflowAuthorPrompt("task");

		expect(prompt).toContain("Output contract:");
		expect(prompt).toContain("structured_output tool call");
		expect(prompt).toContain("'script' field");
	});

	it("produces a shorter prompt for simple tasks than for medium tasks", () => {
		const simplePrompt = buildWorkflowAuthorPrompt("task", { complexityHint: "simple" });
		const mediumPrompt = buildWorkflowAuthorPrompt("task", { complexityHint: "medium" });

		expect(simplePrompt.length).toBeLessThan(mediumPrompt.length);
	});

	it("the iterate workflow is a separate script that references args.instructions and previousResult", () => {
		const script = buildIterateWorkflowScript();

		expect(script).toContain("args.instructions");
		expect(script).toContain("args?.previousResult");
		expect(script).toContain("args.previousTaskId");
		expect(script).toContain("Refine");
		expect(script).toContain("Validate");
		expect(script).toContain("export const meta");
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
		expect(text).toContain(
			"For simple tasks, do not use reviewChange(), continueImplementation(), request_human(), or fix loops",
		);
		expect(text).toContain("For simple docs/text-only edits, do not add reviewChange()");
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

	it("injects deterministic project profile context into author prompts", () => {
		const prompt = buildWorkflowAuthorPrompt("write a feature", {
			projectProfile: {
				root: "/tmp/example",
				detectedStacks: ["python", "make"],
				indicators: ["pyproject.toml", "Makefile"],
				suggestedPrepareCommands: ["python -m pip install -r requirements.txt", "make"],
				suggestedCheckCommands: ["python -m pytest", "make test"],
				summary: "Detected python and make markers",
			},
		});

		expect(prompt).toContain("Workspace profile snapshot (advisory):");
		expect(prompt).toContain("python, make");
		expect(prompt).toContain("python -m pytest");
		expect(prompt).toContain(
			"User instructions are authoritative; advisory profile suggestions may be overridden by explicit task instructions in the request.",
		);
	});
});
