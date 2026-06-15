#!/usr/bin/env tsx
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { KanadePaths } from "../src/config/config.ts";
import { loadConfig } from "../src/config/index.ts";
import { HumanGate } from "../src/human/index.ts";
import { EventBus } from "../src/server/event-bus.ts";
import { TaskManager, type TaskOptions } from "../src/server/task-manager.ts";
import { StateStore } from "../src/store/index.ts";
import { setupTracing } from "../src/tracing/index.ts";
import { validateSemanticWorkflowScript } from "../src/workflow-engine/runtime.ts";

interface Args {
	authorModel: string;
	agentModel: string;
	outputDir: string;
	timeoutMs: number;
	pollMs: number;
	json: boolean;
}

interface CommandResult {
	command: string;
	cwd: string;
	ok: boolean;
	output: string;
}

interface GeneratedLiveReport {
	schemaVersion: 1;
	generatedAt: string;
	root: string;
	fixtureRepo: string;
	kanadeDir: string;
	outputDir: string;
	authorModel: string;
	agentModel: string;
	taskId: string;
	status: string;
	passed: boolean;
	recommendation: "accept" | "inspect" | "reject";
	reasons: string[];
	workflowPath: string;
	workflowScriptPath: string;
	semanticWorkflowOk: boolean;
	semanticWorkflowError?: string;
	worktreePath: string | null;
	worktreeBranch: string | null;
	worktreeStatus: string | null;
	agentCalls: Array<{ label: string; status: string; phase: string | null; role: string | null }>;
	eventTypes: string[];
	checks: CommandResult[];
	diffStat: string;
	diffPatchPath: string;
	resultPreview: string | null;
	error: string | null;
}

const TASK_PROMPT = [
	"You are working in a small temporary Node.js fixture repository.",
	"Task: update the greeting helper so greet() returns exactly 'Hello, Kanade!' instead of the old message.",
	"Also update README.md to document the new greeting output and update the focused test expectation.",
	"Run npm test. Keep the workflow small and focused: implement the change, then validate it.",
	"Do not ask for human input. Do not touch files outside this fixture repository.",
].join("\n");

async function main() {
	const args = parseArgs(process.argv.slice(2));
	mkdirSync(args.outputDir, { recursive: true });
	const root = mkdtempSync(join(tmpdir(), "kanade-generated-live-"));
	const fixtureRepo = join(root, "repo");
	const kanadeDir = join(root, "kanade-dir");
	const evidenceDir = join(root, "evidence");
	mkdirSync(evidenceDir, { recursive: true });
	createFixtureRepo(fixtureRepo);

	const config = loadConfig();
	config.paths = buildTempPaths(kanadeDir);
	ensureKanadeDirs(config.paths);
	config.defaults.authorModel = args.authorModel;
	config.defaults.agentModel = args.agentModel;
	config.defaults.agentTimeoutMs = Math.max(config.defaults.agentTimeoutMs ?? 0, args.timeoutMs);
	config.defaults.taskIdPrefix = "GLS";
	config.isolation.defaultMode = "worktree";
	config.isolation.defaultBaseRepo = fixtureRepo;
	config.isolation.defaultBaseBranch = "main";
	config.isolation.worktreeBaseDir = config.paths.worktreesDir;
	config.debug.persistSubagents = true;
	config.debug.dumpArtifacts = true;

	const tracing = setupTracing(config);
	const store = new StateStore(config.paths.stateDb);
	const events = new EventBus();
	const humanGate = new HumanGate(store, { pollIntervalMs: 5 });
	const taskManager = new TaskManager(config, store, events, humanGate, undefined, tracing);

	let report: GeneratedLiveReport | undefined;
	try {
		console.error(`Fixture repo: ${fixtureRepo}`);
		console.error(`Kanade dir:   ${kanadeDir}`);
		console.error(`Author:       ${args.authorModel}`);
		console.error(`Agent:        ${args.agentModel}`);
		const taskOptions: TaskOptions = {
			cwd: fixtureRepo,
			workflow_size: "small",
			author_model: args.authorModel,
			agent_model: args.agentModel,
		};
		const created = taskManager.create({ source: "generated", prompt: TASK_PROMPT, options: taskOptions });
		console.error(`Task:         ${created.task_id}`);
		const task = await waitForTerminal(taskManager, created.task_id, args.timeoutMs, args.pollMs);
		const workflowScript = existsSync(created.workflow_path) ? readFileSync(created.workflow_path, "utf8") : "";
		const worktree = taskManager.getWorktrees(created.task_id)[0];
		const checks = worktree?.worktree_path ? [runCommand("npm test", worktree.worktree_path)] : [];
		const diffStat = worktree?.worktree_path ? git("diff --stat main...HEAD", worktree.worktree_path, false) : "";
		const diffPatch = worktree?.worktree_path ? git("diff --patch main...HEAD", worktree.worktree_path, false) : "";
		const diffPatchPath = join(args.outputDir, "diff.patch");
		writeFileSync(diffPatchPath, diffPatch, "utf8");
		report = buildReport({
			args,
			root,
			fixtureRepo,
			kanadeDir,
			taskManager,
			events,
			taskId: created.task_id,
			status: task?.status ?? "missing",
			workflowPath: created.workflow_path,
			workflowScript,
			worktree,
			checks,
			diffStat,
			diffPatchPath,
		});
		persistReport(report, args.outputDir, workflowScript);
	} finally {
		await tracing.shutdown();
		store.close();
	}

	if (!report) throw new Error("Smoke report was not produced");
	if (args.json) console.log(JSON.stringify(report, null, 2));
	else console.log(formatReport(report));
	console.log(`Temporary root retained for this run: ${root}`);
	console.log("Remove it manually after inspection if desired.");
	process.exit(report.passed ? 0 : 1);
}

function buildReport(input: {
	args: Args;
	root: string;
	fixtureRepo: string;
	kanadeDir: string;
	taskManager: TaskManager;
	events: EventBus;
	taskId: string;
	status: string;
	workflowPath: string;
	workflowScript: string;
	worktree: ReturnType<TaskManager["getWorktrees"]>[number] | undefined;
	checks: CommandResult[];
	diffStat: string;
	diffPatchPath: string;
}): GeneratedLiveReport {
	const task = input.taskManager.get(input.taskId);
	const agentCalls = input.taskManager.getAgentCalls(input.taskId);
	const eventTypes = [...new Set(input.events.getTaskEvents(input.taskId).map((event) => event.type))];
	const reasons: string[] = [];
	let semanticWorkflowOk = true;
	let semanticWorkflowError: string | undefined;
	try {
		validateSemanticWorkflowScript(input.workflowScript);
	} catch (error) {
		semanticWorkflowOk = false;
		semanticWorkflowError = error instanceof Error ? error.message : String(error);
		reasons.push(`workflow validation failed: ${semanticWorkflowError}`);
	}
	if (input.status !== "finished") reasons.push(`task status is ${input.status}`);
	if (!input.worktree?.worktree_path) reasons.push("no worktree was recorded");
	if (agentCalls.length < 2) reasons.push(`expected at least 2 agent calls, got ${agentCalls.length}`);
	if (!eventTypes.includes("task.script_generated")) reasons.push("missing task.script_generated event");
	if (!eventTypes.includes("task.finished")) reasons.push("missing task.finished event");
	if (!input.diffStat.trim()) reasons.push("no diff was produced");
	if (input.checks.length === 0) reasons.push("no checks were run");
	for (const check of input.checks) {
		if (!check.ok) reasons.push(`check failed: ${check.command}`);
	}
	const passed = reasons.length === 0;
	const recommendation = passed
		? "accept"
		: input.status === "failed" || input.status === "aborted"
			? "reject"
			: "inspect";
	return {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		root: input.root,
		fixtureRepo: input.fixtureRepo,
		kanadeDir: input.kanadeDir,
		outputDir: input.args.outputDir,
		authorModel: input.args.authorModel,
		agentModel: input.args.agentModel,
		taskId: input.taskId,
		status: input.status,
		passed,
		recommendation,
		reasons,
		workflowPath: input.workflowPath,
		workflowScriptPath: join(input.args.outputDir, "workflow.js"),
		semanticWorkflowOk,
		...(semanticWorkflowError ? { semanticWorkflowError } : {}),
		worktreePath: input.worktree?.worktree_path ?? null,
		worktreeBranch: input.worktree?.branch ?? null,
		worktreeStatus: input.worktree?.status ?? null,
		agentCalls: agentCalls.map((call) => ({
			label: call.label,
			status: call.status,
			phase: call.phase,
			role: call.role,
		})),
		eventTypes,
		checks: input.checks,
		diffStat: input.diffStat,
		diffPatchPath: input.diffPatchPath,
		resultPreview: task?.result ? preview(task.result) : null,
		error: task?.error ?? null,
	};
}

function persistReport(report: GeneratedLiveReport, outputDir: string, workflowScript: string): void {
	mkdirSync(outputDir, { recursive: true });
	writeFileSync(join(outputDir, "workflow.js"), workflowScript, "utf8");
	writeFileSync(join(outputDir, "summary.json"), JSON.stringify(report, null, 2), "utf8");
	writeFileSync(join(outputDir, "summary.txt"), formatReport(report), "utf8");
}

function formatReport(report: GeneratedLiveReport): string {
	return [
		"\nGenerated Live Smoke\n",
		`task=${report.taskId} status=${report.status} recommendation=${report.recommendation}`,
		`author=${report.authorModel}`,
		`agent=${report.agentModel}`,
		`fixture=${report.fixtureRepo}`,
		`worktree=${report.worktreePath ?? "none"}`,
		`output=${report.outputDir}`,
		`semanticWorkflowOk=${report.semanticWorkflowOk}`,
		`agentCalls=${report.agentCalls.length}`,
		`checks=${report.checks.map((check) => `${check.command}:${check.ok ? "pass" : "fail"}`).join(", ")}`,
		`diffStat=${report.diffStat.trim() ? report.diffStat.trim().replace(/\n/g, " | ") : "none"}`,
		report.reasons.length ? `reasons=${report.reasons.join("; ")}` : "reasons=none",
		"",
	].join("\n");
}

function createFixtureRepo(dir: string): void {
	mkdirSync(join(dir, "src"), { recursive: true });
	mkdirSync(join(dir, "test"), { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify(
			{
				name: "kanade-generated-live-fixture",
				version: "0.0.0",
				private: true,
				type: "module",
				scripts: { test: "node --test" },
			},
			null,
			2,
		),
		"utf8",
	);
	writeFileSync(
		join(dir, "README.md"),
		"# Generated Live Fixture\n\nThe greeting helper currently returns `Hello, world!`.\n",
		"utf8",
	);
	writeFileSync(join(dir, "src", "greeting.js"), "export function greet() {\n\treturn 'Hello, world!';\n}\n", "utf8");
	writeFileSync(
		join(dir, "test", "greeting.test.js"),
		"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../src/greeting.js';\n\ntest('greet returns the documented message', () => {\n\tassert.equal(greet(), 'Hello, world!');\n});\n",
		"utf8",
	);
	git("init -b main", dir);
	git("config user.email kanade-smoke@example.invalid", dir);
	git("config user.name Kanade Smoke", dir);
	git("add .", dir);
	git("commit -m initial-fixture", dir);
}

function buildTempPaths(root: string): KanadePaths {
	return {
		root,
		configFile: join(root, "config.yml"),
		dbDir: join(root, "db"),
		rolesDir: join(root, "roles"),
		workflowsDir: join(root, "workflows"),
		sharedExtensionsDir: join(root, "shared", "extensions"),
		runsDir: join(root, "runs"),
		worktreesDir: join(root, "worktrees"),
		tracesDir: join(root, "traces"),
		stateDb: join(root, "db", "state.db"),
		logsDir: join(root, "logs"),
	};
}

function ensureKanadeDirs(paths: KanadePaths): void {
	for (const dir of [
		paths.root,
		paths.dbDir,
		paths.rolesDir,
		paths.workflowsDir,
		paths.sharedExtensionsDir,
		paths.runsDir,
		paths.worktreesDir,
		paths.tracesDir,
		paths.logsDir,
	]) {
		mkdirSync(dir, { recursive: true });
	}
}

function waitForTerminal(taskManager: TaskManager, taskId: string, timeoutMs: number, pollMs: number) {
	return new Promise<ReturnType<TaskManager["get"]>>((resolvePromise, reject) => {
		const start = Date.now();
		const timer = setInterval(() => {
			const task = taskManager.get(taskId);
			if (task && ["finished", "failed", "aborted"].includes(task.status)) {
				clearInterval(timer);
				resolvePromise(task);
				return;
			}
			if (Date.now() - start > timeoutMs) {
				clearInterval(timer);
				reject(new Error(`Timeout waiting for generated live task ${taskId}`));
			}
		}, pollMs);
	});
}

function runCommand(command: string, cwd: string): CommandResult {
	try {
		const output = execSync(command, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { command, cwd, ok: true, output };
	} catch (error) {
		const err = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
		return {
			command,
			cwd,
			ok: false,
			output: `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}${err.message ?? ""}`,
		};
	}
}

function git(command: string, cwd: string, throwOnError = true): string {
	try {
		return execSync(`git ${command}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		if (throwOnError) throw error;
		const err = error as { stdout?: Buffer | string; stderr?: Buffer | string };
		return `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`;
	}
}

function parseArgs(argv: string[]): Args {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const args: Args = {
		authorModel: "xiaomi/mimo-v2.5-pro",
		agentModel: "xiaomi/mimo-v2.5-pro",
		outputDir: resolve("eval-artifacts", "generated-live-smoke", stamp),
		timeoutMs: 30 * 60 * 1000,
		pollMs: 5_000,
		json: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (!value) throw new Error(`${arg} requires a value`);
			return value;
		};
		if (arg === "--author-model") args.authorModel = next();
		else if (arg === "--agent-model") args.agentModel = next();
		else if (arg === "--output-dir") args.outputDir = resolve(next());
		else if (arg === "--timeout-ms") args.timeoutMs = Number(next());
		else if (arg === "--poll-ms") args.pollMs = Number(next());
		else if (arg === "--json") args.json = true;
		else if (arg === "--help" || arg === "-h") usage(0);
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return args;
}

function usage(code: number): never {
	console.log(`Usage:
  npm run smoke:generated-live -- [--author-model xiaomi/mimo-v2.5-pro] [--agent-model xiaomi/mimo-v2.5-pro]

Creates a temporary git fixture repository and runs one real generated Kanade task against it.
The Kanade source repository is not modified.

Options:
  --author-model MODEL   Workflow author model (default: xiaomi/mimo-v2.5-pro)
  --agent-model MODEL    Subagent model (default: xiaomi/mimo-v2.5-pro)
  --output-dir DIR       Persist workflow, diff, and summary here
  --timeout-ms N         Task timeout (default: 1800000)
  --poll-ms N            Poll interval (default: 5000)
  --json                 Print JSON report
`);
	process.exit(code);
}

function preview(value: string, limit = 400): string {
	return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

main().catch((error) => {
	console.error("FATAL:", error);
	process.exit(1);
});
