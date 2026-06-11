#!/usr/bin/env tsx
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateSemanticWorkflowScript } from "../src/workflow-engine/runtime.ts";
import { parseArgs, usageAndExit } from "./live-acceptance-args.ts";

const WORKFLOW_HELPERS = [
	"analyze",
	"implement",
	"reviewChange",
	"continueImplementation",
	"testChange",
	"request_human",
	"parallel",
] as const;

type WorkflowHelper = (typeof WORKFLOW_HELPERS)[number];

type TaskStatus = "pending" | "running" | "finished" | "failed" | "aborted" | "needs_human";

type TerminalRejectStatus = "failed" | "aborted" | "needs_human";

interface TaskResponse {
	task_id: string;
	run_dir: string;
	workflow_path: string;
	generated?: true;
}

interface TaskDetail {
	task: {
		task_id: string;
		id: string;
		status: string;
		workflow_path: string;
		base_repo: string | null;
		base_branch: string | null;
		cwd: string | null;
		error: string | null;
		result: string | null;
	};
	usage?: unknown;
}

interface WorktreeRow {
	label: string;
	branch: string;
	base_branch: string;
	worktree_path: string;
	status: string;
	merge_commit: string | null;
}

interface CheckResult {
	command: string;
	ok: boolean;
	output: string;
}

interface WorkflowSummary {
	phases: string[];
	helperCalls: Record<WorkflowHelper, number>;
	hasImplementation: boolean;
	hasReview: boolean;
	hasValidation: boolean;
	hasFixLoop: boolean;
}

interface WorktreeDiffEvidence {
	path: string;
	head: string;
	changedFiles: string[];
	diffStat: string;
}

interface AcceptanceEvidence {
	usage: {
		hasUsageRecord: boolean;
		isZeroUsage: boolean;
	};
	result: {
		hasResult: boolean;
		hasFailedValidation: boolean;
	};
	worktrees: {
		count: number;
		atLeastOneCommit: boolean;
	};
}

interface AcceptanceReport {
	taskId: string;
	status: string;
	workflowPath: string;
	semanticWorkflowOk: boolean;
	semanticWorkflowError?: string;
	resultOk: boolean;
	resultStatusSummary: unknown;
	usage: unknown;
	worktrees: WorktreeRow[];
	workflowSummary: WorkflowSummary;
	worktreeDiffs: WorktreeDiffEvidence[];
	evidence: AcceptanceEvidence;
	git: {
		mainDirty: boolean;
		worktreeDirty: Array<{ path: string; dirty: boolean; status: string }>;
		commits: Array<{ path: string; head: string }>;
	};
	prepare: CheckResult[];
	checks: CheckResult[];
	checksCwd: string;
	recommendation: "accept" | "inspect" | "reject";
	reasons: string[];
}

interface RecommendationInput {
	taskStatus: string;
	semanticWorkflowOk: boolean;
	hasFailedValidation: boolean;
	hasWorktrees: boolean;
	hasAtLeastOneWorktreeCommit: boolean;
	allWorktreesClean: boolean;
	mainClean: boolean;
	prepareOk: boolean;
	checksOk: boolean;
	taskError: string | null;
	hasResult: boolean;
}

interface RecommendationResult {
	recommendation: "accept" | "inspect" | "reject";
	reasons: string[];
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, init);
	const text = await response.text();
	if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url} failed ${response.status}: ${text}`);
	return JSON.parse(text) as T;
}

function git(cwd: string, command: string): string {
	return execSync(`git ${command}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function safeGit(cwd: string, command: string): string {
	try {
		return git(cwd, command);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function runCheck(cwd: string, command: string): CheckResult {
	try {
		const output = execSync(command, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			shell: "/bin/bash",
		});
		return { command, ok: true, output: output.trim() };
	} catch (error) {
		const err = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
		const output = [err.stdout?.toString(), err.stderr?.toString(), err.message].filter(Boolean).join("\n").trim();
		return { command, ok: false, output };
	}
}

function parseResult(result: string | null): unknown {
	if (!result) return null;
	try {
		return JSON.parse(result) as unknown;
	} catch {
		return result;
	}
}

function summarizeResult(value: unknown): unknown {
	if (!value || typeof value !== "object") return value;
	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of ["review", "validation", "result", "implementation", "candidate", "final"]) {
		const child = input[key];
		if (child && typeof child === "object") {
			const obj = child as Record<string, unknown>;
			output[key] = { status: obj.status, summary: obj.summary, issues: obj.issues, warnings: obj.warnings };
		}
	}
	return Object.keys(output).length > 0 ? output : value;
}

function hasFailedValidation(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const stack: unknown[] = [value];
	while (stack.length) {
		const current = stack.pop();
		if (!current || typeof current !== "object") continue;
		const obj = current as Record<string, unknown>;
		if (obj.status === "failed") return true;
		for (const child of Object.values(obj)) {
			if (child && typeof child === "object") stack.push(child);
		}
	}
	return false;
}

function sanitizeForRegexExtraction(source: string, preserveStringLiterals = true): string {
	let output = "";
	let i = 0;
	let mode: "normal" | "line-comment" | "block-comment" | "single-quote" | "double-quote" | "template" = "normal";

	function isEscaped(position: number): boolean {
		let backslashCount = 0;
		for (let index = position - 1; index >= 0; index -= 1) {
			if (source[index] !== "\\") break;
			backslashCount += 1;
		}
		return backslashCount % 2 === 1;
	}

	function appendSafe(ch: string): void {
		if (preserveStringLiterals) {
			output += ch;
		} else {
			output += ch === "\n" ? "\n" : " ";
		}
	}

	while (i < source.length) {
		const current = source[i];
		const next = source[i + 1];

		if (mode === "normal") {
			if (current === "/" && next === "/") {
				mode = "line-comment";
				output += "  ";
				i += 2;
			} else if (current === "/" && next === "*") {
				mode = "block-comment";
				output += "  ";
				i += 2;
			} else if (current === "'") {
				mode = "single-quote";
				output += "'";
				i += 1;
			} else if (current === '"') {
				mode = "double-quote";
				output += '"';
				i += 1;
			} else if (current === "`") {
				mode = "template";
				output += "`";
				i += 1;
			} else {
				output += current;
				i += 1;
			}
			continue;
		}

		if (mode === "line-comment") {
			output += current === "\n" ? "\n" : " ";
			if (current === "\n") mode = "normal";
			i += 1;
			continue;
		}

		if (mode === "block-comment") {
			if (current === "*" && next === "/") {
				mode = "normal";
				output += "  ";
				i += 2;
			} else {
				output += current === "\n" ? "\n" : " ";
				i += 1;
			}
			continue;
		}

		if (mode === "single-quote") {
			if (current === "\\" && !preserveStringLiterals && next !== undefined) {
				output += "  ";
				appendSafe(next);
				i += 2;
				continue;
			}
			if (current === "\\" && preserveStringLiterals && next !== undefined) {
				appendSafe(current);
				appendSafe(next);
				i += 2;
				continue;
			}
			if (current === "'" && !isEscaped(i)) {
				mode = "normal";
				appendSafe(current);
				i += 1;
				continue;
			}
			appendSafe(current);
			i += 1;
			continue;
		}

		if (mode === "double-quote") {
			if (current === "\\" && !preserveStringLiterals && next !== undefined) {
				output += "  ";
				appendSafe(next);
				i += 2;
				continue;
			}
			if (current === "\\" && preserveStringLiterals && next !== undefined) {
				appendSafe(current);
				appendSafe(next);
				i += 2;
				continue;
			}
			if (current === '"' && !isEscaped(i)) {
				mode = "normal";
				appendSafe(current);
				i += 1;
				continue;
			}
			appendSafe(current);
			i += 1;
			continue;
		}

		if (mode === "template") {
			if (current === "\\" && !preserveStringLiterals && next !== undefined) {
				output += "  ";
				appendSafe(next);
				i += 2;
				continue;
			}
			if (current === "\\" && preserveStringLiterals && next !== undefined) {
				appendSafe(current);
				appendSafe(next);
				i += 2;
				continue;
			}
			if (current === "`") {
				mode = "normal";
				appendSafe(current);
				i += 1;
				continue;
			}
			appendSafe(current);
			i += 1;
		}
	}

	return output;
}

function unescapeStringLiteral(raw: string): string {
	return raw.replace(/\\./g, (match) => {
		const char = match[1] ?? "";
		switch (char) {
			case "n":
				return "\n";
			case "r":
				return "\r";
			case "t":
				return "\t";
			default:
				return char;
		}
	});
}

export function parseNameStatusChangedFiles(value: string): string[] {
	const files = new Set<string>();
	for (const line of value.split("\n")) {
		const tabIndex = line.indexOf("\t");
		if (tabIndex < 0) continue;
		const rest = line.slice(tabIndex + 1).trim();
		if (!rest) continue;
		for (const file of rest
			.split("\t")
			.map((entry) => entry.trim())
			.filter(Boolean)) {
			if (file === "/dev/null") continue;
			files.add(file.replaceAll("\\", "/"));
		}
	}
	return [...files].sort();
}

export function extractWorkflowSummary(script: string): WorkflowSummary {
	const cleanedForPhases = sanitizeForRegexExtraction(script);
	const cleanedForHelpers = sanitizeForRegexExtraction(script, false);
	const phases: string[] = [];
	const phaseSet = new Set<string>();
	const phaseRegex = /\bphase\s*\(\s*(["'`])([\s\S]*?)\1/g;
	for (const match of cleanedForPhases.matchAll(phaseRegex)) {
		const value = unescapeStringLiteral((match[2] ?? "").trim());
		if (!value) continue;
		if (!phaseSet.has(value)) {
			phaseSet.add(value);
			phases.push(value);
		}
	}

	const helperCalls = WORKFLOW_HELPERS.reduce(
		(acc, name) => {
			acc[name] = 0;
			return acc;
		},
		{} as Record<WorkflowHelper, number>,
	);

	for (const helper of WORKFLOW_HELPERS) {
		const regex = new RegExp(`\\b${helper}\\s*\\(`, "g");
		for (const _ of cleanedForHelpers.matchAll(regex)) {
			helperCalls[helper] += 1;
		}
	}

	return {
		phases,
		helperCalls,
		hasImplementation: helperCalls.implement > 0,
		hasReview: helperCalls.reviewChange > 0,
		hasValidation: helperCalls.testChange > 0,
		hasFixLoop: helperCalls.continueImplementation > 0,
	};
}

export function isUsageZero(value: unknown): boolean {
	if (value === null || value === undefined) return true;
	if (typeof value === "number") return value === 0;
	if (typeof value === "string") {
		const numeric = Number(value);
		if (Number.isFinite(numeric)) return numeric === 0;
		return value.trim().length === 0;
	}
	if (typeof value === "boolean") return !value;
	if (Array.isArray(value)) return value.every((item) => isUsageZero(item));
	if (typeof value === "object") {
		const values = Object.values(value as Record<string, unknown>);
		if (values.length === 0) return true;
		return values.every((item) => isUsageZero(item));
	}
	return false;
}

function extractUsageNumber(value: unknown, keys: string[]): number | undefined {
	let current = value;
	for (const key of keys) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	if (typeof current === "number") return current;
	if (typeof current === "string") {
		const numeric = Number(current);
		return Number.isFinite(numeric) ? numeric : undefined;
	}
	return undefined;
}

export function classifyAcceptance(inputs: RecommendationInput): RecommendationResult {
	const reasons: string[] = [];
	const taskStatus = inputs.taskStatus as TaskStatus;

	if (inputs.taskStatus !== "finished") {
		reasons.push(`task status is ${inputs.taskStatus}`);
	}
	if (!inputs.semanticWorkflowOk) reasons.push("workflow failed semantic validation");
	if (!inputs.hasWorktrees) reasons.push("no worktree was recorded");
	if (!inputs.hasAtLeastOneWorktreeCommit) reasons.push("no worktree commit was recorded");
	if (!inputs.mainClean) reasons.push("main workspace is dirty");
	if (!inputs.allWorktreesClean) reasons.push("one or more worktrees are dirty");
	if (!inputs.prepareOk) reasons.push("prepare command(s) failed");
	if (!inputs.checksOk) reasons.push("check command(s) failed");
	if (!inputs.hasResult) reasons.push("task result is empty");
	if (inputs.taskError) reasons.push(`task error: ${inputs.taskError}`);
	if (inputs.hasFailedValidation) reasons.push("result contains failed validation status");

	const hardRejectStatuses: TerminalRejectStatus[] = ["failed", "aborted", "needs_human"];
	const isHardReject =
		hardRejectStatuses.includes(taskStatus) ||
		!inputs.semanticWorkflowOk ||
		!inputs.mainClean ||
		!inputs.allWorktreesClean ||
		!inputs.prepareOk ||
		!inputs.checksOk;

	const canAccept =
		taskStatus === "finished" &&
		inputs.hasResult &&
		inputs.semanticWorkflowOk &&
		!inputs.hasFailedValidation &&
		inputs.hasWorktrees &&
		inputs.hasAtLeastOneWorktreeCommit &&
		inputs.allWorktreesClean &&
		inputs.mainClean &&
		inputs.prepareOk &&
		inputs.checksOk;

	if (canAccept) {
		return { recommendation: "accept", reasons: [] };
	}

	return {
		recommendation: isHardReject ? "reject" : "inspect",
		reasons,
	};
}

function isGitCommandError(value: string): boolean {
	return /^\s*fatal:/.test(value) || value.includes("fatal:") || /not a git repository/.test(value);
}

function collectWorktreeDiffEvidence(worktree: WorktreeRow): WorktreeDiffEvidence {
	const rawHead = safeGit(worktree.worktree_path, "log --oneline -1 --no-decorate");
	const hasHead = rawHead.trim().length > 0 && !isGitCommandError(rawHead);
	const diffStat = hasHead ? safeGit(worktree.worktree_path, "show --stat --pretty=format: HEAD --") : "";
	const nameStatus = hasHead ? safeGit(worktree.worktree_path, "show --name-status --pretty=format: HEAD --") : "";
	return {
		path: worktree.worktree_path,
		head: hasHead ? rawHead.trim() : "",
		changedFiles: hasHead ? parseNameStatusChangedFiles(nameStatus) : [],
		diffStat: isGitCommandError(diffStat) ? "" : diffStat.trim(),
	};
}

function formatUsageSection(usage: unknown, worktreeCommitEvidence: boolean): void {
	const cost = extractUsageNumber(usage, ["cost", "total"]);
	const totalTokens = extractUsageNumber(usage, ["totalTokens"]);
	console.log("usage/cost:");
	console.log(`  usage.recorded=${usage !== null && usage !== undefined ? "yes" : "no"}`);
	console.log(`  zero-usage=${isUsageZero(usage) ? "yes" : "no"}`);
	console.log(`  worktree.commit.present=${worktreeCommitEvidence ? "yes" : "no"}`);
	if (cost !== undefined) console.log(`  cost.total=$${cost.toFixed(4)}`);
	if (totalTokens !== undefined) console.log(`  tokens.total=${Math.round(totalTokens)}`);
}

function formatWorkflowSummary(summary: WorkflowSummary): void {
	console.log("workflow summary:");
	console.log(`  phases: ${summary.phases.length > 0 ? summary.phases.join(" -> ") : "(none)"}`);
	const helperSummary = WORKFLOW_HELPERS.map((name) => `${name}=${summary.helperCalls[name]}`).join(", ");
	console.log(`  helper calls: ${helperSummary}`);
	console.log(
		`  traits: implementation=${summary.hasImplementation ? "yes" : "no"}, review=${summary.hasReview ? "yes" : "no"}, validation=${
			summary.hasValidation ? "yes" : "no"
		}, fix-loop=${summary.hasFixLoop ? "yes" : "no"}`,
	);
}

function printNonJsonReport(report: AcceptanceReport): void {
	console.log(`\nLive acceptance report: ${report.taskId}`);
	console.log(`status: ${report.status}`);
	console.log(`recommendation: ${report.recommendation}`);
	formatWorkflowSummary(report.workflowSummary);

	console.log("\nDiff summary:");
	if (report.worktreeDiffs.length === 0) {
		console.log("  (no worktrees)");
	} else {
		for (const diff of report.worktreeDiffs) {
			const worktreePath = relative(process.cwd(), diff.path);
			const stat = diff.diffStat ? ` | stat: ${diff.diffStat.replace(/\n/g, " ").trim()}` : "";
			console.log(
				`  ${worktreePath}: head=${diff.head || "<no commit>"}${stat.length > 0 ? stat : ""}, files=${diff.changedFiles.length}`,
			);
			if (diff.changedFiles.length > 0) {
				console.log(`    files: ${diff.changedFiles.join(", ")}`);
			}
		}
	}

	console.log(`\nchecks cwd: ${report.checksCwd}`);
	for (const step of report.prepare) console.log(`  prepare ${step.ok ? "ok" : "failed"}: ${step.command}`);
	for (const check of report.checks) console.log(`  check ${check.ok ? "ok" : "failed"}: ${check.command}`);

	console.log("\nUsage/cost:");
	formatUsageSection(report.usage, report.evidence.worktrees.atLeastOneCommit);
	console.log("\nRecommendation reasons:");
	if (report.reasons.length === 0) {
		console.log("  - none");
	} else {
		for (const reason of report.reasons) console.log(`  - ${reason}`);
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const prompt = args.promptFile ? readFileSync(args.promptFile, "utf8") : args.prompt;
	if (!prompt?.trim()) usageAndExit(1);

	const task = await requestJson<TaskResponse>(`${args.baseUrl}/tasks`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			source: "generated",
			prompt,
			options: {
				cwd: args.cwd,
				...(args.authorModel ? { author_model: args.authorModel } : {}),
				...(args.agentModel ? { agent_model: args.agentModel } : {}),
				...(Object.keys(args.roleModels).length ? { role_models: args.roleModels } : {}),
				...(args.prepareCommands.length ? { prepare_commands: args.prepareCommands } : {}),
			},
		}),
	});
	if (!args.json) console.error(`created ${task.task_id}`);

	const deadline = Date.now() + args.timeoutMs;
	let detail: TaskDetail | undefined;
	while (Date.now() < deadline) {
		detail = await requestJson<TaskDetail>(`${args.baseUrl}/tasks/${task.task_id}`);
		if (!args.json) console.error(`status=${detail.task.status}`);
		if (["finished", "failed", "aborted", "needs_human"].includes(detail.task.status)) break;
		await new Promise((resolvePoll) => setTimeout(resolvePoll, args.pollMs));
	}
	if (!detail) throw new Error("task was never fetched");

	const worktreesResponse = await requestJson<{ worktrees: WorktreeRow[] }>(
		`${args.baseUrl}/tasks/${task.task_id}/worktrees`,
	);
	const workflowScript = existsSync(detail.task.workflow_path) ? readFileSync(detail.task.workflow_path, "utf8") : "";
	const workflowSummary = extractWorkflowSummary(workflowScript);

	let semanticWorkflowOk = true;
	let semanticWorkflowError: string | undefined;
	try {
		validateSemanticWorkflowScript(workflowScript);
	} catch (error) {
		semanticWorkflowOk = false;
		semanticWorkflowError = error instanceof Error ? error.message : String(error);
	}

	const parsedResult = parseResult(detail.task.result);
	const checksCwd = worktreesResponse.worktrees[0]?.worktree_path ?? args.cwd;
	const prepare = args.prepare.map((command) => runCheck(checksCwd, command));
	const prepareOk = prepare.every((step) => step.ok);
	const checks = prepareOk ? args.checks.map((check) => runCheck(checksCwd, check)) : [];
	const checksOk = checks.every((step) => step.ok);
	const worktreeDirty = worktreesResponse.worktrees.map((worktree) => {
		const status = safeGit(worktree.worktree_path, "status --short");
		return { path: worktree.worktree_path, dirty: status.trim().length > 0, status };
	});
	const allWorktreesClean = !worktreeDirty.some((entry) => entry.dirty);
	const worktreeDiffs = worktreesResponse.worktrees.map(collectWorktreeDiffEvidence);
	const commits = worktreeDiffs.map((diff) => ({ path: diff.path, head: diff.head }));
	const mainStatus = safeGit(args.cwd, "status --short");
	const hasAtLeastOneWorktreeCommit = worktreeDiffs.some((diff) => diff.head.length > 0);

	const decision = classifyAcceptance({
		taskStatus: detail.task.status,
		semanticWorkflowOk,
		hasFailedValidation: hasFailedValidation(parsedResult),
		hasWorktrees: worktreesResponse.worktrees.length > 0,
		hasAtLeastOneWorktreeCommit,
		allWorktreesClean,
		mainClean: mainStatus.trim().length === 0,
		prepareOk,
		checksOk,
		taskError: detail.task.error,
		hasResult: Boolean(detail.task.result),
	});

	const reasons = decision.reasons;

	const report: AcceptanceReport = {
		taskId: task.task_id,
		status: detail.task.status,
		workflowPath: detail.task.workflow_path,
		semanticWorkflowOk,
		...(semanticWorkflowError ? { semanticWorkflowError } : {}),
		resultOk: Boolean(detail.task.result) && !hasFailedValidation(parsedResult),
		resultStatusSummary: summarizeResult(parsedResult),
		usage: detail.usage,
		worktrees: worktreesResponse.worktrees,
		workflowSummary,
		worktreeDiffs,
		evidence: {
			usage: {
				hasUsageRecord: detail.usage !== undefined,
				isZeroUsage: isUsageZero(detail.usage),
			},
			result: {
				hasResult: Boolean(detail.task.result),
				hasFailedValidation: hasFailedValidation(parsedResult),
			},
			worktrees: {
				count: worktreesResponse.worktrees.length,
				atLeastOneCommit: hasAtLeastOneWorktreeCommit,
			},
		},
		git: {
			mainDirty: mainStatus.trim().length > 0,
			worktreeDirty,
			commits,
		},
		prepare,
		checks,
		checksCwd,
		recommendation: decision.recommendation,
		reasons,
	};

	if (args.json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		printNonJsonReport(report);
	}

	if (decision.recommendation === "reject") process.exitCode = 2;
	else if (decision.recommendation === "inspect") process.exitCode = 1;
}

const isEntry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url : false;

if (isEntry) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.stack || error.message : String(error));
		process.exit(2);
	});
}
