import {
	buildLegacyWorkflowAuthorPrompt,
	buildWorkflowAuthorPrompt,
} from "../../src/workflow-engine/prompt-guidelines.ts";
import type { AuthorEvalCase } from "./cases.ts";

export type PromptVariant = "current-no-read" | "semantic-no-read";

export function buildEvalPrompt(input: { evalCase: AuthorEvalCase; variant: PromptVariant }): string {
	const taskBlock = [
		`Task (${input.evalCase.complexity}):`,
		input.evalCase.task,
		"",
		"Workspace brief:",
		input.evalCase.workspaceBrief,
	].join("\n");

	if (input.variant === "current-no-read") {
		return buildLegacyWorkflowAuthorPrompt(taskBlock);
	}

	return buildWorkflowAuthorPrompt(taskBlock, { complexityHint: input.evalCase.complexity });
}
