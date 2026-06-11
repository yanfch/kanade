import { describe, expect, it } from "vitest";

import { parseArgs } from "../scripts/live-acceptance-args.ts";
import {
	classifyAcceptance,
	extractWorkflowSummary,
	isUsageZero,
	parseNameStatusChangedFiles,
} from "../scripts/live-acceptance.ts";

describe("live-acceptance argument parsing", () => {
	it("parses task-level --prepare-command and local --prepare separately", () => {
		const args = parseArgs([
			"--prompt",
			"run this",
			"--prepare",
			"npm install",
			"--prepare-command",
			"npm install",
			"--prepare-command",
			"npm run test",
		]);

		expect(args.prepare).toEqual(["npm install"]);
		expect(args.prepareCommands).toEqual(["npm install", "npm run test"]);
	});

	it("accepts repeatable role-model and run-level model flags", () => {
		const args = parseArgs([
			"--prompt",
			"run this",
			"--role-model",
			"reviewer=gpt-5.4",
			"--role-model",
			"dev=gpt-5.3-codex-spark",
		]);

		expect(args.roleModels).toEqual({ reviewer: "gpt-5.4", dev: "gpt-5.3-codex-spark" });
	});
});

describe("live-acceptance workflow summary helper", () => {
	it("extracts phases and helper call counts deterministically", () => {
		const script = `
			export const meta = { name: 'demo', description: 'demo workflow' };
			const note = "await implement('ignored')";
			// analyze("ignored")
			/* request_human({ title: 'ignored' }) */
			phase("analyze");
			await analyze("Plan the task", { role: 'planner' });
			await implement('Make the change', { role: 'developer' });
			await reviewChange(undefined, { role: 'reviewer' });
			await continueImplementation(undefined, { feedback: 'fix issue', role: 'developer' });
			await testChange(undefined, { role: 'tester' });
			await parallel([() => request_human({ title: 'Approve?' })]);
			phase('analyze');
			phase("validation");
		`;

		const summary = extractWorkflowSummary(script);
		expect(summary.phases).toEqual(["analyze", "validation"]);
		expect(summary.helperCalls.analyze).toBe(1);
		expect(summary.helperCalls.implement).toBe(1);
		expect(summary.helperCalls.reviewChange).toBe(1);
		expect(summary.helperCalls.continueImplementation).toBe(1);
		expect(summary.helperCalls.testChange).toBe(1);
		expect(summary.helperCalls.parallel).toBe(1);
		expect(summary.helperCalls.request_human).toBe(1);
		expect(summary.hasImplementation).toBe(true);
		expect(summary.hasReview).toBe(true);
		expect(summary.hasValidation).toBe(true);
		expect(summary.hasFixLoop).toBe(true);
	});
});

describe("live-acceptance usage/result helpers", () => {
	it("parses name-status diff output into sorted changed files", () => {
		expect(parseNameStatusChangedFiles("A\tfoo.ts\nM\tbar.ts\nR100\told.ts\tnew.ts\n")).toEqual([
			"bar.ts",
			"foo.ts",
			"new.ts",
			"old.ts",
		]);
	});

	it("detects zero workflow usage totals", () => {
		expect(
			isUsageZero({
				input: 0,
				output: 0,
				cost: { total: 0 },
				cacheRead: 0,
				cacheWrite: 0,
			}),
		).toBe(true);
		expect(isUsageZero({ input: 1, cost: { total: 0 } })).toBe(false);
	});

	it("classifies accept/inspect/reject decisions deterministically", () => {
		const base = {
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
			hasResult: true,
			usageIsZero: false,
		};

		const accept = classifyAcceptance(base);
		expect(accept.recommendation).toBe("accept");
		expect(accept.reasons).toEqual([]);

		const emptyResult = classifyAcceptance({ ...base, hasResult: false });
		expect(emptyResult.recommendation).toBe("inspect");
		expect(emptyResult.reasons).toContain("task result is empty");

		const zeroUsage = classifyAcceptance({ ...base, usageIsZero: true });
		expect(zeroUsage.recommendation).toBe("inspect");
		expect(zeroUsage.reasons).toContain("usage appears to be zero");

		const inspect = classifyAcceptance({ ...base, hasAtLeastOneWorktreeCommit: false });
		expect(inspect.recommendation).toBe("inspect");
		expect(inspect.reasons).toContain("no worktree commit was recorded");

		const reject = classifyAcceptance({
			...base,
			taskStatus: "failed",
			semanticWorkflowOk: false,
			hasFailedValidation: true,
			prepareOk: false,
			checksOk: false,
			taskError: "boom",
			hasResult: false,
			usageIsZero: true,
		});
		expect(reject.recommendation).toBe("reject");
		expect(reject.reasons).toContain("workflow failed semantic validation");
		expect(reject.reasons).toContain("prepare command(s) failed");
		expect(reject.reasons).toContain("check command(s) failed");
	});
});
