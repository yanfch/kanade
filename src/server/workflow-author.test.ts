import { describe, expect, it } from "vitest";
import { buildWorkflowAuthorFailureMessage, selectWorkflowScript, validateWorkflowScript } from "./workflow-author.ts";

const VALID_SEMANTIC_SCRIPT =
	"export const meta = { name: 'valid_workflow', description: 'A valid semantic workflow' }\n" +
	"phase('Implement');\n" +
	"return await implement('Refactor safely', { role: 'developer' })";

const RAW_VALID_SCRIPT =
	"export const meta = { name: 'raw_workflow', description: 'A raw but valid assistant script' }\n" +
	"phase('Validate');\n" +
	"return await implement('Run validation', { role: 'developer' })";

function assistantTextMessage(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
	};
}

describe("workflow author helpers", () => {
	it("accepts a valid semantic workflow script", () => {
		expect(validateWorkflowScript(VALID_SEMANTIC_SCRIPT)).toBeUndefined();
	});

	it("rejects parse-invalid workflow script", () => {
		const invalid = "export const meta = { name: 'invalid' }";
		expect(validateWorkflowScript(invalid)).toContain("meta.description");
	});

	it("rejects semantic-invalid raw agent script", () => {
		const invalid =
			"export const meta = { name: 'raw_agent_workflow', description: 'Invalid semantic usage' }\n" +
			"return await agent('do work', { label: 'legacy' })";
		expect(validateWorkflowScript(invalid)).toContain("raw agent() is not allowed");
	});

	it("prefers captured candidate first, then falls back to raw assistant text", () => {
		const rawMessage = assistantTextMessage(RAW_VALID_SCRIPT);
		const captured =
			"export const meta = { name: 'captured_workflow', description: 'Captured candidate wins' }\n" +
			"phase('Review');\n" +
			"return await implement('Prefer this candidate', { role: 'developer' })";

		const resultCaptured = selectWorkflowScript(captured, [rawMessage]);
		expect(resultCaptured.script).toBe(captured);
		expect(resultCaptured.validationError).toBeUndefined();

		const capturedInvalid = "export const meta = { name: 'captured_invalid' }";
		const resultFallback = selectWorkflowScript(capturedInvalid, [rawMessage]);
		expect(resultFallback.script).toBe(RAW_VALID_SCRIPT);
	});

	it("reports the last candidate validation error when both candidates fail", () => {
		const invalidCaptured = "export const meta = { name: 'captured_invalid' }";
		const invalidRaw =
			"export const meta = { name: 'raw_invalid', description: 'still bad' }\n" +
			"return await agent('use legacy helper', { label: 'legacy' })";
		const message = assistantTextMessage(invalidRaw);

		const result = selectWorkflowScript(invalidCaptured, [message]);
		expect(result.script).toBeUndefined();
		expect(result.validationError).toContain("raw agent() is not allowed");

		const failureMessage = buildWorkflowAuthorFailureMessage(3, result.validationError, [message]);
		expect(failureMessage).toContain("3 attempts");
		expect(failureMessage).toContain("raw agent() is not allowed");
		expect(failureMessage).toContain("msgs=");
	});
});
