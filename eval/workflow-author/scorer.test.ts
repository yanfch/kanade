import { describe, expect, it } from "vitest";
import { AUTHOR_EVAL_CASES } from "./cases.ts";
import { scoreAuthorOutput } from "./scorer.ts";

function getCase(id: string) {
	const found = AUTHOR_EVAL_CASES.find((item) => item.id === id);
	if (!found) throw new Error(`Missing case: ${id}`);
	return found;
}

describe("workflow author scorer", () => {
	it("penalizes forbidden semantic steps on simple cases", () => {
		const result = scoreAuthorOutput({
			evalCase: getCase("S1"),
			variant: "semantic-no-read",
			script: [
				"export const meta = { name: 'bad_simple', description: 'Bad simple workflow' };",
				"phase('Analyze');",
				"const analysis = await analyze('Read broadly first.', { role: 'planner' });",
				"phase('Implement');",
				"return await implement('Fix the bug.', { role: 'developer' });",
			].join("\n"),
		});

		expect(result.score).toBeLessThan(1);
		expect(result.notes.join(" | ")).toContain("uses forbidden step kind for this case: analyze");
	});

	it("penalizes Java workflows that use npm defaults", () => {
		const result = scoreAuthorOutput({
			evalCase: getCase("J1"),
			variant: "semantic-no-read",
			script: [
				"export const meta = { name: 'java_npm', description: 'Bad java guidance' };",
				"phase('Implement');",
				"const implementation = await implement('Refactor Java error handling in the scheduler.', { role: 'developer' });",
				"phase('Validate');",
				"const validation = await testChange(implementation, {",
				"  role: 'tester',",
				"  guidance: 'Run npm test and report pass/fail clearly.',",
				"  output: { type: 'object', properties: { status: { type: 'string', enum: ['passed', 'failed'] }, summary: { type: 'string' }, issues: { type: 'array', items: { type: 'string' } }, warnings: { type: 'array', items: { type: 'string' } } }, required: ['status', 'summary', 'issues'] }",
				"});",
				"return { implementation, validation };",
			].join("\n"),
		});

		expect(result.passed).toBe(false);
		expect(result.notes.join(" | ")).toContain("validation guidance used Node defaults for non-java-maven case");
	});

	it("penalizes non-Node npm defaults even when they are placed in implement prompts", () => {
		const result = scoreAuthorOutput({
			evalCase: getCase("J1"),
			variant: "semantic-no-read",
			script: [
				"export const meta = { name: 'java_npm_implement', description: 'Bad java implement guidance' };",
				"phase('Implement');",
				"const implementation = await implement('Refactor Java error handling, add tests, and run npm test.', { role: 'developer' });",
				"phase('Validate');",
				"const validation = await testChange(implementation, { role: 'tester', guidance: 'Report whether validation passed.' });",
				"return { implementation, validation };",
			].join("\n"),
		});

		expect(result.passed).toBe(false);
		expect(result.notes.join(" | ")).toContain("validation guidance used Node defaults for non-java-maven case");
	});

	it("rewards Java workflows that use project-appropriate Maven commands", () => {
		const result = scoreAuthorOutput({
			evalCase: getCase("J1"),
			variant: "semantic-no-read",
			script: [
				"export const meta = { name: 'java_maven', description: 'Project-appropriate java guidance' };",
				"phase('Implement');",
				"const implementation = await implement('Refactor Java error handling in the scheduler.', { role: 'developer' });",
				"phase('Review');",
				"const review = await reviewChange(implementation, { role: 'reviewer', guidance: 'Review Java scheduler correctness and test coverage.' });",
				"phase('Validate');",
				"const validation = await testChange(implementation, {",
				"  role: 'tester',",
				"  guidance: 'Inspect pom.xml and run ./mvnw test.',",
				"  output: { type: 'object', properties: { status: { type: 'string', enum: ['passed', 'failed'] }, summary: { type: 'string' }, issues: { type: 'array', items: { type: 'string' } }, warnings: { type: 'array', items: { type: 'string' } } }, required: ['status', 'summary', 'issues'] }",
				"});",
				"return { implementation, review, validation };",
			].join("\n"),
		});

		expect(result.score).toBeGreaterThan(0.85);
		expect(result.notes.join(" | ")).toContain("validation guidance uses project-appropriate command for java-maven");
		expect(result.notes.join(" | ")).not.toContain("uses forbidden step kind for this case: reviewChange");
	});

	it("rewards Python workflows with pytest guidance", () => {
		const result = scoreAuthorOutput({
			evalCase: getCase("P1"),
			variant: "semantic-no-read",
			script: [
				"export const meta = { name: 'python_pytest', description: 'Python pytest guidance' };",
				"phase('Implement');",
				"const implementation = await implement('Fix CLI argument parsing edge case.', { role: 'developer' });",
				"phase('Validate');",
				"const validation = await testChange(implementation, {",
				"  role: 'tester',",
				"  guidance: 'Inspect requirements.txt and pyproject.toml, then run pytest.',",
				"  output: { type: 'object', properties: { status: { type: 'string', enum: ['passed', 'failed'] }, summary: { type: 'string' }, issues: { type: 'array', items: { type: 'string' } }, warnings: { type: 'array', items: { type: 'string' } } }, required: ['status', 'summary', 'issues'] }",
				"});",
				"return { implementation, validation };",
			].join("\n"),
		});

		expect(result.score).toBeGreaterThan(0.85);
		expect(result.notes.join(" | ")).toContain("validation guidance uses project-appropriate command for python");
	});

	it("rewards Gradle, Rust, and Go project command guidance", () => {
		const cases = [
			{
				id: "G1",
				command: "./gradlew test",
				note: "validation guidance uses project-appropriate command for java-gradle",
			},
			{ id: "R1", command: "cargo test", note: "validation guidance uses project-appropriate command for rust" },
			{ id: "GO1", command: "go test ./...", note: "validation guidance uses project-appropriate command for go" },
		];

		for (const item of cases) {
			const result = scoreAuthorOutput({
				evalCase: getCase(item.id),
				variant: "semantic-no-read",
				script: [
					`export const meta = { name: '${item.id.toLowerCase()}_commands', description: 'Stack guidance' };`,
					"phase('Implement');",
					"const implementation = await implement('Make the focused code change and update regression tests.', { role: 'developer' });",
					"phase('Validate');",
					"const validation = await testChange(implementation, {",
					"  role: 'tester',",
					`  guidance: 'Run ${item.command} and report pass/fail clearly.',`,
					"});",
					"return { implementation, validation };",
				].join("\n"),
			});

			expect(result.score).toBeGreaterThan(0.85);
			expect(result.notes.join(" | ")).toContain(item.note);
		}
	});

	it("accepts fallback Python guidance when command is not discoverable", () => {
		const result = scoreAuthorOutput({
			evalCase: getCase("P1"),
			variant: "semantic-no-read",
			script: [
				"export const meta = { name: 'python_fallback', description: 'Python fallback guidance' };",
				"phase('Implement');",
				"const implementation = await implement('Fix CLI argument parsing edge case.', { role: 'developer' });",
				"phase('Validate');",
				"const validation = await testChange(implementation, {",
				"  role: 'tester',",
				"  guidance: 'Run relevant project checks after inspecting requirements and test docs; no automated command was discoverable.',",
				"  output: { type: 'object', properties: { status: { type: 'string', enum: ['passed', 'failed'] }, summary: { type: 'string' }, issues: { type: 'array', items: { type: 'string' } }, warnings: { type: 'array', items: { type: 'string' } } }, required: ['status', 'summary', 'issues'] }",
				"});",
				"return { implementation, validation };",
			].join("\n"),
		});

		expect(result.score).toBeGreaterThan(0.7);
		expect(result.notes.join(" | ")).not.toContain("validation guidance used Node defaults for non-python case");
	});

	it("penalizes docs-only workflows that assume language build commands", () => {
		const result = scoreAuthorOutput({
			evalCase: getCase("D1"),
			variant: "semantic-no-read",
			script: [
				"export const meta = { name: 'docs_npm', description: 'Bad docs guidance' };",
				"phase('Implement');",
				"const implementation = await implement('Clarify Markdown docs and then run npm test.', { role: 'developer' });",
				"return { implementation };",
			].join("\n"),
		});

		expect(result.passed).toBe(false);
		expect(result.notes.join(" | ")).toContain("uses forbidden guidance pattern: /\\bnpm\\b/i");
	});

	it("enforces explicit validation instructions over advisory profile suggestions", () => {
		const result = scoreAuthorOutput({
			evalCase: getCase("X1"),
			variant: "semantic-no-read",
			script: [
				"export const meta = { name: 'docs_make', description: 'Explicit docs validation' };",
				"phase('Implement');",
				"const implementation = await implement('Update README wording only and validate with make docs-check; do not run npm.', { role: 'developer' });",
				"return { implementation };",
			].join("\n"),
		});

		expect(result.passed).toBe(true);
		expect(result.notes.join(" | ")).not.toContain("missing required guidance pattern");
		expect(result.notes.join(" | ")).not.toContain("uses forbidden guidance pattern");
	});

	it("penalizes raw pipeline() usage in semantic workflows", () => {
		const result = scoreAuthorOutput({
			evalCase: getCase("M3"),
			variant: "semantic-no-read",
			script: [
				"export const meta = { name: 'bad_pipeline', description: 'Bad raw pipeline usage' };",
				"return await pipeline(['prompt cleanup'], async (item) => implement(item, { role: 'developer' }));",
			].join("\n"),
		});

		expect(result.passed).toBe(false);
		expect(result.notes.join(" | ")).toContain("semantic prompt fell back to raw pipeline() API");
	});

	it("penalizes authored iterate branches in semantic workflows", () => {
		const result = scoreAuthorOutput({
			evalCase: getCase("M3"),
			variant: "semantic-no-read",
			script: [
				"export const meta = { name: 'bad_iterate_branch', description: 'Bad iterate branch' };",
				"const instructions = typeof args?.instructions === 'string' ? args.instructions : '';",
				"if (instructions) {",
				"  return await implement(`Refine using ${args.previousTaskId}`, { role: 'developer' });",
				"}",
				"return await implement('Do the change.', { role: 'developer' });",
			].join("\n"),
		});

		expect(result.passed).toBe(false);
		expect(result.notes.join(" | ")).toContain(
			"semantic prompt authored a custom iterate branch instead of staying on the generated-task path",
		);
	});

	it("does not treat raw agent() mentions inside prompt text as a raw API fallback", () => {
		const result = scoreAuthorOutput({
			evalCase: getCase("C1"),
			variant: "semantic-no-read",
			script: [
				"export const meta = { name: 'mention_agent_text', description: 'Mention agent in text only' };",
				"phase('Implement');",
				"const implementation = await implement('Remove references to raw agent() and pipeline() from the generated prompt.', { role: 'developer' });",
				"phase('Validate');",
				"return { implementation, validation: await testChange(implementation, { role: 'tester' }) };",
			].join("\n"),
		});

		expect(result.notes.join(" | ")).not.toContain("semantic prompt fell back to raw agent() API");
	});

	it("does not count worktree discussion in prompt text as low-level execution control", () => {
		const result = scoreAuthorOutput({
			evalCase: getCase("C2"),
			variant: "semantic-no-read",
			script: [
				"export const meta = { name: 'discuss_isolation', description: 'Discuss isolation subject matter' };",
				"phase('Analyze');",
				"const analysis = await analyze('Analyze git worktree isolation semantics and branch lifecycle as subject matter only.', { role: 'planner' });",
				"return { analysis, decision: await request_human({ title: 'Approve direction?', detail: 'This change affects worktree behavior and branch cleanup.' }) };",
			].join("\n"),
		});

		expect(result.metrics.lowLevelControlCount).toBe(0);
		expect(result.notes.join(" | ")).not.toContain("uses low-level execution controls");
	});

	it("accepts a minimal semantic workflow for a simple validation case", () => {
		const result = scoreAuthorOutput({
			evalCase: getCase("S3"),
			variant: "semantic-no-read",
			model: "xiaomi/mimo-v2.5-pro",
			script: [
				"export const meta = { name: 'simple_validate', description: 'Simple validate workflow' };",
				"phase('Implement');",
				"const implementation = await implement('Make the small API change and update focused tests.', { role: 'developer' });",
				"phase('Validate');",
				"const validation = await testChange(implementation, { role: 'tester', guidance: 'Run the focused app and CLI tests only.' });",
				"return { implementation, validation };",
			].join("\n"),
		});

		expect(result.passed).toBe(true);
		expect(result.model).toBe("xiaomi/mimo-v2.5-pro");
		expect(result.metrics.workflowSize).toBe("small");
		expect(result.metrics.workflowSizeFit).toBe(true);
		expect(result.metrics.hasTest).toBe(true);
		expect(result.metrics.usesKinds).toEqual(["implement", "testChange"]);
	});

	it("flags over-complex workflows for small cases", () => {
		const result = scoreAuthorOutput({
			evalCase: getCase("S1"),
			variant: "semantic-no-read",
			script: [
				"export const meta = { name: 'too_large_simple', description: 'Over-complex simple workflow' };",
				"phase('Analyze');",
				"const analysis = await analyze('Analyze broadly before a tiny fix.', { role: 'planner' });",
				"phase('Implement');",
				"const implementation = await implement('Fix the retry bug.', { role: 'developer' });",
				"phase('Review');",
				"const review = await reviewChange(implementation, { role: 'reviewer' });",
				"phase('Validate');",
				"const validation = await testChange(implementation, { role: 'tester' });",
				"return { analysis, implementation, review, validation };",
			].join("\n"),
		});

		expect(result.metrics.workflowSize).toBe("small");
		expect(result.metrics.workflowSizeFit).toBe(false);
		expect(result.metrics.agentCountEstimate).toBe(4);
		expect(result.notes.join(" | ")).toContain("workflow size mismatch for small case");
	});
});
