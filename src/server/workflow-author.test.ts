import { describe, expect, it } from "vitest";
import {
	buildWorkflowAuthorFailureMessage,
	selectWorkflowScript,
	validateGeneratedWorkflowScript,
	validateWorkflowScript,
} from "./workflow-author.ts";

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

	it("rejects empty and parse-invalid workflow scripts", () => {
		expect(validateWorkflowScript(undefined)).toContain("empty");
		expect(validateWorkflowScript("export const meta =")).toBeTruthy();
	});

	it("rejects semantic-invalid workflow metadata", () => {
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

describe("validateGeneratedWorkflowScript", () => {
	it("accepts a script with implement() call", () => {
		const script =
			"export const meta = { name: 'valid', description: 'Valid' }\n" +
			"return await implement('Do the change', { role: 'developer' })";
		expect(validateGeneratedWorkflowScript(script)).toBeUndefined();
	});

	it("accepts a script with analyze() call", () => {
		const script =
			"export const meta = { name: 'valid', description: 'Valid' }\n" + "return await analyze('Plan the change')";
		expect(validateGeneratedWorkflowScript(script)).toBeUndefined();
	});

	it("accepts a script with reviewChange() call", () => {
		const script =
			"export const meta = { name: 'valid', description: 'Valid' }\n" +
			"return await reviewChange({}, { role: 'reviewer' })";
		expect(validateGeneratedWorkflowScript(script)).toBeUndefined();
	});

	it("accepts a script with continueImplementation() call", () => {
		const script =
			"export const meta = { name: 'valid', description: 'Valid' }\n" +
			"return await continueImplementation({}, { role: 'developer', feedback: {} })";
		expect(validateGeneratedWorkflowScript(script)).toBeUndefined();
	});

	it("accepts a script with testChange() call", () => {
		const script =
			"export const meta = { name: 'valid', description: 'Valid' }\n" +
			"return await testChange({}, { role: 'tester' })";
		expect(validateGeneratedWorkflowScript(script)).toBeUndefined();
	});

	it("accepts a script with request_human() call", () => {
		const script =
			"export const meta = { name: 'valid', description: 'Valid' }\n" +
			"return await request_human({ title: 'Approve?' })";
		expect(validateGeneratedWorkflowScript(script)).toBeUndefined();
	});

	it("accepts a script with parallel() call", () => {
		const script =
			"export const meta = { name: 'valid', description: 'Valid' }\n" +
			"return await parallel([() => implement('a'), () => implement('b')])";
		expect(validateGeneratedWorkflowScript(script)).toBeUndefined();
	});

	it("rejects empty script", () => {
		expect(validateGeneratedWorkflowScript(undefined)).toContain("empty");
		expect(validateGeneratedWorkflowScript("")).toContain("empty");
		expect(validateGeneratedWorkflowScript("   ")).toContain("empty");
	});

	it("rejects script with no executable body", () => {
		const script = "export const meta = { name: 'empty', description: 'Empty' }";
		expect(validateGeneratedWorkflowScript(script)).toContain("no executable body");
	});

	it("rejects stub workflow with only return {}", () => {
		const script = "export const meta = { name: 'generated', description: 'Generated workflow' }\n" + "return {}";
		expect(validateGeneratedWorkflowScript(script)).toContain("must call at least one semantic helper");
	});

	it("rejects script with only return true", () => {
		const script = "export const meta = { name: 'stub', description: 'Stub' }\n" + "return true";
		expect(validateGeneratedWorkflowScript(script)).toContain("must call at least one semantic helper");
	});

	it("rejects script with only variable declarations", () => {
		const script = "export const meta = { name: 'stub', description: 'Stub' }\n" + "const x = 1";
		expect(validateGeneratedWorkflowScript(script)).toContain("must call at least one semantic helper");
	});

	it("rejects script with raw agent() call (semantic validation still applies)", () => {
		const script =
			"export const meta = { name: 'bad', description: 'Bad' }\n" + "return await agent('do work', { label: 'test' })";
		expect(validateGeneratedWorkflowScript(script)).toContain("raw agent() is not allowed");
	});

	it("rejects script with missing metadata (parse validation still applies)", () => {
		const script = "export const meta = { name: 'invalid' }";
		expect(validateGeneratedWorkflowScript(script)).toContain("meta.description");
	});
});
