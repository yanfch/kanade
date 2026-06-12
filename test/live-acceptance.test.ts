import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { parseArgs } from "../scripts/live-acceptance-args.ts";
import {
	DIFF_PATCH_TRUNCATE_LIMIT,
	classifyAcceptance,
	collectWorktreeDiffEvidence,
	extractWorkflowSummary,
	formatTaskEvent,
	isUsageZero,
	parseNameStatusChangedFiles,
	truncateDiffPatch,
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

	it("parses an explicit evidence file path", () => {
		const args = parseArgs(["--prompt", "run this", "--evidence-file", "./tmp/evidence.json"]);

		expect(args.evidenceFile).toBe(resolve("./tmp/evidence.json"));
	});

	it("uses scalar defaults while keeping repeatable args explicit", () => {
		const args = parseArgs(["--prompt", "run this", "--check", "npm test"], {
			authorModel: "openai-codex:gpt-5.4",
			agentModel: "xiaomi/mimo-v2.5-pro",
			timeoutMs: 1234,
			pollMs: 250,
		});

		expect(args.authorModel).toBe("openai-codex:gpt-5.4");
		expect(args.agentModel).toBe("xiaomi/mimo-v2.5-pro");
		expect(args.timeoutMs).toBe(1234);
		expect(args.pollMs).toBe(250);
		expect(args.checks).toEqual(["npm test"]);
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

describe("live-acceptance event formatting", () => {
	it("formats terminal task and workflow events with a compact detail", () => {
		expect(
			formatTaskEvent({
				id: 1,
				type: "task.failed",
				taskId: "T-1",
				data: { error: "validation failed" },
				ts: new Date("2026-06-12T07:21:22.467Z").getTime(),
			}),
		).toContain("task.failed  validation failed");
		expect(
			formatTaskEvent({
				id: 2,
				type: "workflow.agent_completed",
				data: { label: "Validate", result: null },
				ts: new Date("2026-06-12T07:21:18.376Z").getTime(),
			}),
		).toContain("workflow.agent_completed  Validate result=null");
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

describe("live-acceptance diff patch truncation", () => {
	it("returns the full patch when under the limit", () => {
		const patch = "a".repeat(DIFF_PATCH_TRUNCATE_LIMIT - 1);
		const result = truncateDiffPatch(patch);
		expect(result.patch).toBe(patch);
		expect(result.truncated).toBe(false);
		expect(result.originalPatchLength).toBe(patch.length);
	});

	it("returns the full patch when exactly at the limit", () => {
		const patch = "b".repeat(DIFF_PATCH_TRUNCATE_LIMIT);
		const result = truncateDiffPatch(patch);
		expect(result.patch).toBe(patch);
		expect(result.truncated).toBe(false);
		expect(result.originalPatchLength).toBe(patch.length);
	});

	it("truncates a patch exceeding the limit and records metadata", () => {
		const patch = "c".repeat(DIFF_PATCH_TRUNCATE_LIMIT + 500);
		const result = truncateDiffPatch(patch);
		expect(result.patch).toBe("c".repeat(DIFF_PATCH_TRUNCATE_LIMIT));
		expect(result.truncated).toBe(true);
		expect(result.originalPatchLength).toBe(DIFF_PATCH_TRUNCATE_LIMIT + 500);
	});

	it("supports a custom limit", () => {
		const patch = "x".repeat(200);
		const result = truncateDiffPatch(patch, 100);
		expect(result.patch).toBe("x".repeat(100));
		expect(result.truncated).toBe(true);
		expect(result.originalPatchLength).toBe(200);
	});

	it("returns an empty patch as-is", () => {
		const result = truncateDiffPatch("");
		expect(result.patch).toBe("");
		expect(result.truncated).toBe(false);
		expect(result.originalPatchLength).toBe(0);
	});
});

describe("live-acceptance collectWorktreeDiffEvidence truncation integration", () => {
	it("includes truncated/originalPatchLength in evidence and preserves changedFiles/diffStat when patch exceeds limit", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "ldp-truncation-test-"));
		try {
			// Initialize a git repo with a base commit
			execSync("git init", { cwd: tmpDir, stdio: "ignore" });
			execSync("git config user.email test@test", { cwd: tmpDir, stdio: "ignore" });
			execSync("git config user.name test", { cwd: tmpDir, stdio: "ignore" });
			writeFileSync(join(tmpDir, "base.txt"), "base content\n");
			execSync("git add base.txt", { cwd: tmpDir, stdio: "ignore" });
			execSync("git commit -m initial", { cwd: tmpDir, stdio: "ignore" });

			// Create a worktree on a new branch
			const worktreePath = join(tmpDir, "worktree-feature");
			execSync(`git worktree add -b feature ${worktreePath}`, { cwd: tmpDir, stdio: "ignore" });

			// Add a file with content exceeding DIFF_PATCH_TRUNCATE_LIMIT to the worktree
			const largeContent = "x".repeat(DIFF_PATCH_TRUNCATE_LIMIT + 1000);
			writeFileSync(join(worktreePath, "large-file.txt"), `${largeContent}\n`);
			writeFileSync(join(worktreePath, "small-file.txt"), "small change\n");
			execSync("git add large-file.txt small-file.txt", { cwd: worktreePath, stdio: "ignore" });
			execSync("git commit -m 'add files'", { cwd: worktreePath, stdio: "ignore" });

			const worktree = {
				label: "LDP-0001",
				branch: "feature",
				base_branch: "main",
				worktree_path: worktreePath,
				status: "active",
				merge_commit: null,
			};

			const evidence = collectWorktreeDiffEvidence(worktree);

			// Verify truncation fields are present and correct
			expect(evidence.truncated).toBe(true);
			expect(evidence.originalPatchLength).toBeGreaterThan(DIFF_PATCH_TRUNCATE_LIMIT);
			expect(evidence.diffPatch.length).toBeLessThanOrEqual(DIFF_PATCH_TRUNCATE_LIMIT);

			// Verify changedFiles is still populated despite truncation
			expect(evidence.changedFiles).toContain("large-file.txt");
			expect(evidence.changedFiles).toContain("small-file.txt");

			// Verify diffStat is still populated despite truncation
			expect(evidence.diffStat).toBeTruthy();
			expect(evidence.diffStat).toContain("large-file.txt");

			// Verify head is populated
			expect(evidence.head).toBeTruthy();
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("does not set truncated when patch is under the limit", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "ldp-no-truncation-"));
		try {
			execSync("git init", { cwd: tmpDir, stdio: "ignore" });
			execSync("git config user.email test@test", { cwd: tmpDir, stdio: "ignore" });
			execSync("git config user.name test", { cwd: tmpDir, stdio: "ignore" });
			writeFileSync(join(tmpDir, "base.txt"), "base content\n");
			execSync("git add base.txt", { cwd: tmpDir, stdio: "ignore" });
			execSync("git commit -m initial", { cwd: tmpDir, stdio: "ignore" });

			const worktreePath = join(tmpDir, "worktree-feature");
			execSync(`git worktree add -b feature ${worktreePath}`, { cwd: tmpDir, stdio: "ignore" });

			// Add a small file that won't trigger truncation
			writeFileSync(join(worktreePath, "tiny.txt"), "small\n");
			execSync("git add tiny.txt", { cwd: worktreePath, stdio: "ignore" });
			execSync("git commit -m 'add tiny'", { cwd: worktreePath, stdio: "ignore" });

			const worktree = {
				label: "LDP-0002",
				branch: "feature",
				base_branch: "main",
				worktree_path: worktreePath,
				status: "active",
				merge_commit: null,
			};

			const evidence = collectWorktreeDiffEvidence(worktree);

			expect(evidence.truncated).toBe(false);
			expect(evidence.originalPatchLength).toBeLessThanOrEqual(DIFF_PATCH_TRUNCATE_LIMIT);
			expect(evidence.changedFiles).toContain("tiny.txt");
			expect(evidence.diffStat).toBeTruthy();
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
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
