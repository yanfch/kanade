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
		expect(result.metrics.usesKinds).toEqual(["implement", "testChange"]);
	});
});
