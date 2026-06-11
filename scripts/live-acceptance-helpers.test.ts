import { describe, expect, it } from "vitest";

import { classifyAcceptance, extractWorkflowSummary } from "./live-acceptance.ts";

describe("live-acceptance helper extraction", () => {
	it("extracts helper calls from executable code while ignoring comments and strings", () => {
		const script = `
			const note = "await implement(\"ignored\")\nrequest_human({title: \"ignored\"})";
			// analyze("ignored")
			/* implement(\"ignored\") */
			phase("analysis");
			await analyze("Plan", { role: "planner" });
			await implement("Change", { role: "developer" });
			await continueImplementation(undefined, { role: "developer" });
		`;

		const summary = extractWorkflowSummary(script);

		expect(summary.phases).toEqual(["analysis"]);
		expect(summary.helperCalls.analyze).toBe(1);
		expect(summary.helperCalls.implement).toBe(1);
		expect(summary.helperCalls.continueImplementation).toBe(1);
		expect(summary.helperCalls.reviewChange).toBe(0);
		expect(summary.helperCalls.request_human).toBe(0);
		expect(summary.hasImplementation).toBe(true);
	});
});

describe("live-acceptance recommendation", () => {
	it("does not recommend accept when task result is empty", () => {
		const decision = classifyAcceptance({
			taskStatus: "finished",
			semanticWorkflowOk: true,
			hasFailedValidation: false,
			hasWorktrees: true,
			hasAtLeastOneWorktreeCommit: true,
			allWorktreesClean: true,
			mainClean: true,
			prepareOk: true,
			checksOk: true,
			taskError: null,
			hasResult: false,
		});

		expect(decision.recommendation).toBe("inspect");
		expect(decision.reasons).toContain("task result is empty");
	});
});
