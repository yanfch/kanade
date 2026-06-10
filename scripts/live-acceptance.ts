#!/usr/bin/env tsx
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateSemanticWorkflowScript } from "../src/workflow-engine/runtime.ts";

interface Args {
	baseUrl: string;
	prompt?: string;
	promptFile?: string;
	model?: string;
	cwd: string;
	timeoutMs: number;
	pollMs: number;
	checks: string[];
	json: boolean;
}

interface TaskResponse {
	task_id: string;
	run_dir: string;
	workflow_path: string;
	generated?: true;
}

interface TaskDetail {
	task: {
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
	git: {
		mainDirty: boolean;
		worktreeDirty: Array<{ path: string; dirty: boolean; status: string }>;
		commits: Array<{ path: string; head: string }>;
	};
	checks: CheckResult[];
	checksCwd: string;
	recommendation: "accept" | "inspect" | "reject";
	reasons: string[];
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		baseUrl: process.env.KANADE_URL ?? "http://127.0.0.1:7777",
		cwd: process.cwd(),
		timeoutMs: 30 * 60 * 1000,
		pollMs: 10_000,
		checks: [],
		json: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (!value) throw new Error(`${arg} requires a value`);
			return value;
		};
		if (arg === "--base-url") args.baseUrl = next();
		else if (arg === "--prompt") args.prompt = next();
		else if (arg === "--prompt-file") args.promptFile = next();
		else if (arg === "--model") args.model = next();
		else if (arg === "--cwd") args.cwd = resolve(next());
		else if (arg === "--timeout-ms") args.timeoutMs = Number(next());
		else if (arg === "--poll-ms") args.pollMs = Number(next());
		else if (arg === "--check") args.checks.push(next());
		else if (arg === "--json") args.json = true;
		else if (arg === "--help" || arg === "-h") usageAndExit(0);
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return args;
}

function usageAndExit(code: number): never {
	console.log(`Usage:
  npm run live:accept -- --prompt "..." --model gpt-5.3-codex-spark --base-url http://127.0.0.1:7781 --check "npm run typecheck" --check "npm run lint"

Options:
  --prompt TEXT          Generated task prompt
  --prompt-file PATH     Read generated task prompt from file
  --model MODEL          Model passed to Kanade task options
  --cwd PATH             Workspace cwd for the task and local checks (default: current cwd)
  --base-url URL         Kanade server URL (default: KANADE_URL or http://127.0.0.1:7777)
  --timeout-ms N         Poll timeout (default: 1800000)
  --poll-ms N            Poll interval (default: 10000)
  --check COMMAND        Local acceptance check to run after task completion; repeatable
  --json                 Print machine-readable JSON only
`);
	process.exit(code);
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
		const output = execSync(command, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: "/bin/bash" });
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
			options: { cwd: args.cwd, ...(args.model ? { model: args.model } : {}) },
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
	const checks = args.checks.map((check) => runCheck(checksCwd, check));
	const worktreeDirty = worktreesResponse.worktrees.map((worktree) => {
		const status = safeGit(worktree.worktree_path, "status --short");
		return { path: worktree.worktree_path, dirty: status.trim().length > 0, status };
	});
	const commits = worktreesResponse.worktrees.map((worktree) => ({
		path: worktree.worktree_path,
		head: safeGit(worktree.worktree_path, "log --oneline -1"),
	}));
	const mainStatus = safeGit(args.cwd, "status --short");
	const reasons: string[] = [];
	if (detail.task.status !== "finished") reasons.push(`task status is ${detail.task.status}`);
	if (!semanticWorkflowOk) reasons.push("workflow failed semantic validation");
	if (detail.task.error) reasons.push(`task error: ${detail.task.error}`);
	if (!detail.task.result) reasons.push("task result is empty");
	if (hasFailedValidation(parsedResult)) reasons.push("result contains failed validation status");
	if (worktreesResponse.worktrees.length === 0) reasons.push("no worktree was recorded");
	if (worktreeDirty.some((entry) => entry.dirty)) reasons.push("one or more worktrees are dirty");
	if (mainStatus.trim()) reasons.push("main workspace is dirty");
	for (const check of checks) {
		if (!check.ok) reasons.push(`check failed: ${check.command}`);
	}
	const recommendation = reasons.length === 0 ? "accept" : detail.task.status === "finished" ? "inspect" : "reject";
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
		git: {
			mainDirty: mainStatus.trim().length > 0,
			worktreeDirty,
			commits,
		},
		checks,
		checksCwd,
		recommendation,
		reasons,
	};

	if (args.json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(`\nLive acceptance report: ${report.taskId}`);
		console.log(`status: ${report.status}`);
		console.log(
			`workflow: ${report.semanticWorkflowOk ? "semantic-ok" : `semantic-failed: ${report.semanticWorkflowError}`}`,
		);
		console.log(`worktrees: ${report.worktrees.length}`);
		for (const commit of report.git.commits) console.log(`commit: ${commit.head} (${commit.path})`);
		if (report.checks.length) console.log(`checks cwd: ${report.checksCwd}`);
		for (const check of report.checks) console.log(`check ${check.ok ? "ok" : "failed"}: ${check.command}`);
		console.log(`recommendation: ${report.recommendation}`);
		if (report.reasons.length) console.log(`reasons:\n- ${report.reasons.join("\n- ")}`);
		console.log(`\nJSON:\n${JSON.stringify(report, null, 2)}`);
	}

	if (recommendation === "reject") process.exitCode = 2;
	else if (recommendation === "inspect") process.exitCode = 1;
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack || error.message : String(error));
	process.exit(2);
});
