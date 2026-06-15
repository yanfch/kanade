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
	workflowName: string;
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

interface RunEvidence {
	kind: "generated" | "saved";
	taskId: string;
	status: string;
	workflowPath: string;
	workflowScriptPath: string;
	semanticWorkflowOk: boolean;
	semanticWorkflowError?: string;
	worktreePath: string | null;
	worktreeBranch: string | null;
	agentCalls: Array<{ label: string; status: string; phase: string | null; role: string | null }>;
	eventTypes: string[];
	checks: CommandResult[];
	diffStat: string;
	diffPatchPath: string;
	resultPreview: string | null;
	error: string | null;
	reasons: string[];
	passed: boolean;
}

interface PromotionReport {
	schemaVersion: 1;
	generatedAt: string;
	root: string;
	kanadeDir: string;
	generatedFixtureRepo: string;
	savedFixtureRepo: string;
	outputDir: string;
	authorModel: string;
	agentModel: string;
	workflowName: string;
	savedWorkflowPath: string;
	workflowPromotionOk: boolean;
	passed: boolean;
	recommendation: "accept" | "inspect" | "reject";
	reasons: string[];
	runs: RunEvidence[];
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
	const root = mkdtempSync(join(tmpdir(), "kanade-workflow-promotion-"));
	const generatedRepo = join(root, "repo-generated");
	const savedRepo = join(root, "repo-saved");
	const kanadeDir = join(root, "kanade-dir");
	createFixtureRepo(generatedRepo);
	createFixtureRepo(savedRepo);

	const config = loadConfig();
	config.paths = buildTempPaths(kanadeDir);
	ensureKanadeDirs(config.paths);
	config.defaults.authorModel = args.authorModel;
	config.defaults.agentModel = args.agentModel;
	config.defaults.agentTimeoutMs = Math.max(config.defaults.agentTimeoutMs ?? 0, args.timeoutMs);
	config.defaults.taskIdPrefix = "WPS";
	config.isolation.defaultMode = "worktree";
	config.isolation.defaultBaseBranch = "main";
	config.isolation.worktreeBaseDir = config.paths.worktreesDir;
	config.debug.persistSubagents = true;
	config.debug.dumpArtifacts = true;

	const tracing = setupTracing(config);
	const store = new StateStore(config.paths.stateDb);
	const events = new EventBus();
	const humanGate = new HumanGate(store, { pollIntervalMs: 5 });
	const taskManager = new TaskManager(config, store, events, humanGate, undefined, tracing);

	let report: PromotionReport | undefined;
	try {
		console.error(`Generated fixture: ${generatedRepo}`);
		console.error(`Saved fixture:     ${savedRepo}`);
		console.error(`Kanade dir:        ${kanadeDir}`);
		console.error(`Author:            ${args.authorModel}`);
		console.error(`Agent:             ${args.agentModel}`);

		config.isolation.defaultBaseRepo = generatedRepo;
		taskManager.updateConfig(config);
		const generated = await runGeneratedTask({ args, taskManager, events, repo: generatedRepo });
		if (generated.passed) {
			taskManager.save(generated.taskId, args.workflowName);
		} else {
			console.error("Generated run failed; saving workflow anyway for evidence inspection.");
			try {
				taskManager.save(generated.taskId, args.workflowName);
			} catch {
				// Ignore; report will show promotion failure.
			}
		}
		const savedWorkflowPath = join(config.paths.workflowsDir, `${args.workflowName}.js`);
		const workflowPromotionOk = existsSync(savedWorkflowPath);
		config.isolation.defaultBaseRepo = savedRepo;
		taskManager.updateConfig(config);
		const saved = workflowPromotionOk
			? await runSavedTask({ args, taskManager, events, repo: savedRepo })
			: skippedSavedRun(args.outputDir);

		report = buildPromotionReport({
			args,
			root,
			kanadeDir,
			generatedRepo,
			savedRepo,
			savedWorkflowPath,
			workflowPromotionOk,
			runs: [generated, saved],
		});
		persistReport(report, args.outputDir);
	} finally {
		await tracing.shutdown();
		store.close();
	}

	if (!report) throw new Error("Promotion report was not produced");
	if (args.json) console.log(JSON.stringify(report, null, 2));
	else console.log(formatReport(report));
	console.log(`Temporary root retained for this run: ${root}`);
	console.log("Remove it manually after inspection if desired.");
	process.exit(report.passed ? 0 : 1);
}

async function runGeneratedTask(input: {
	args: Args;
	taskManager: TaskManager;
	events: EventBus;
	repo: string;
}): Promise<RunEvidence> {
	const taskOptions: TaskOptions = {
		cwd: input.repo,
		workflow_size: "small",
		author_model: input.args.authorModel,
		agent_model: input.args.agentModel,
	};
	const created = input.taskManager.create({ source: "generated", prompt: TASK_PROMPT, options: taskOptions });
	console.error(`Generated task:   ${created.task_id}`);
	await waitForTerminal(input.taskManager, created.task_id, input.args.timeoutMs, input.args.pollMs);
	return collectRunEvidence({
		kind: "generated",
		taskManager: input.taskManager,
		events: input.events,
		taskId: created.task_id,
		workflowPath: created.workflow_path,
		outputDir: input.args.outputDir,
	});
}

async function runSavedTask(input: {
	args: Args;
	taskManager: TaskManager;
	events: EventBus;
	repo: string;
}): Promise<RunEvidence> {
	const taskOptions: TaskOptions = {
		cwd: input.repo,
		agent_model: input.args.agentModel,
	};
	const created = input.taskManager.create({
		source: "saved",
		workflow_name: input.args.workflowName,
		options: taskOptions,
	});
	console.error(`Saved task:       ${created.task_id}`);
	await waitForTerminal(input.taskManager, created.task_id, input.args.timeoutMs, input.args.pollMs);
	return collectRunEvidence({
		kind: "saved",
		taskManager: input.taskManager,
		events: input.events,
		taskId: created.task_id,
		workflowPath: created.workflow_path,
		outputDir: input.args.outputDir,
	});
}

function collectRunEvidence(input: {
	kind: "generated" | "saved";
	taskManager: TaskManager;
	events: EventBus;
	taskId: string;
	workflowPath: string;
	outputDir: string;
}): RunEvidence {
	const task = input.taskManager.get(input.taskId);
	const script = existsSync(input.workflowPath) ? readFileSync(input.workflowPath, "utf8") : "";
	const worktree = input.taskManager.getWorktrees(input.taskId)[0];
	const checks = worktree?.worktree_path ? [runCommand("npm test", worktree.worktree_path)] : [];
	const diffStat = worktree?.worktree_path ? git("diff --stat main...HEAD", worktree.worktree_path, false) : "";
	const diffPatch = worktree?.worktree_path ? git("diff --patch main...HEAD", worktree.worktree_path, false) : "";
	const workflowScriptPath = join(input.outputDir, `${input.kind}.workflow.js`);
	const diffPatchPath = join(input.outputDir, `${input.kind}.diff.patch`);
	writeFileSync(workflowScriptPath, script, "utf8");
	writeFileSync(diffPatchPath, diffPatch, "utf8");
	const reasons: string[] = [];
	let semanticWorkflowOk = true;
	let semanticWorkflowError: string | undefined;
	try {
		validateSemanticWorkflowScript(script);
	} catch (error) {
		semanticWorkflowOk = false;
		semanticWorkflowError = error instanceof Error ? error.message : String(error);
		reasons.push(`workflow validation failed: ${semanticWorkflowError}`);
	}
	const agentCalls = input.taskManager.getAgentCalls(input.taskId);
	const eventTypes = [...new Set(input.events.getTaskEvents(input.taskId).map((event) => event.type))];
	if (task?.status !== "finished") reasons.push(`task status is ${task?.status ?? "missing"}`);
	if (!worktree?.worktree_path) reasons.push("no worktree was recorded");
	if (agentCalls.length < 2) reasons.push(`expected at least 2 agent calls, got ${agentCalls.length}`);
	if (!eventTypes.includes("task.finished")) reasons.push("missing task.finished event");
	if (!diffStat.trim()) reasons.push("no diff was produced");
	if (checks.length === 0) reasons.push("no checks were run");
	for (const check of checks) {
		if (!check.ok) reasons.push(`check failed: ${check.command}`);
	}
	return {
		kind: input.kind,
		taskId: input.taskId,
		status: task?.status ?? "missing",
		workflowPath: input.workflowPath,
		workflowScriptPath,
		semanticWorkflowOk,
		...(semanticWorkflowError ? { semanticWorkflowError } : {}),
		worktreePath: worktree?.worktree_path ?? null,
		worktreeBranch: worktree?.branch ?? null,
		agentCalls: agentCalls.map((call) => ({
			label: call.label,
			status: call.status,
			phase: call.phase,
			role: call.role,
		})),
		eventTypes,
		checks,
		diffStat,
		diffPatchPath,
		resultPreview: task?.result ? preview(task.result) : null,
		error: task?.error ?? null,
		reasons,
		passed: reasons.length === 0,
	};
}

function skippedSavedRun(outputDir: string): RunEvidence {
	return {
		kind: "saved",
		taskId: "skipped",
		status: "skipped",
		workflowPath: "",
		workflowScriptPath: join(outputDir, "saved.workflow.js"),
		semanticWorkflowOk: false,
		worktreePath: null,
		worktreeBranch: null,
		agentCalls: [],
		eventTypes: [],
		checks: [],
		diffStat: "",
		diffPatchPath: join(outputDir, "saved.diff.patch"),
		resultPreview: null,
		error: "workflow promotion failed",
		reasons: ["workflow promotion failed; saved run skipped"],
		passed: false,
	};
}

function buildPromotionReport(input: {
	args: Args;
	root: string;
	kanadeDir: string;
	generatedRepo: string;
	savedRepo: string;
	savedWorkflowPath: string;
	workflowPromotionOk: boolean;
	runs: RunEvidence[];
}): PromotionReport {
	const reasons: string[] = [];
	if (!input.workflowPromotionOk) reasons.push("workflow was not saved");
	for (const run of input.runs) {
		for (const reason of run.reasons) reasons.push(`${run.kind}: ${reason}`);
	}
	const passed = reasons.length === 0;
	return {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		root: input.root,
		kanadeDir: input.kanadeDir,
		generatedFixtureRepo: input.generatedRepo,
		savedFixtureRepo: input.savedRepo,
		outputDir: input.args.outputDir,
		authorModel: input.args.authorModel,
		agentModel: input.args.agentModel,
		workflowName: input.args.workflowName,
		savedWorkflowPath: input.savedWorkflowPath,
		workflowPromotionOk: input.workflowPromotionOk,
		passed,
		recommendation: passed ? "accept" : input.runs.some((run) => run.status === "failed") ? "reject" : "inspect",
		reasons,
		runs: input.runs,
	};
}

function persistReport(report: PromotionReport, outputDir: string): void {
	mkdirSync(outputDir, { recursive: true });
	writeFileSync(join(outputDir, "summary.json"), JSON.stringify(report, null, 2), "utf8");
	writeFileSync(join(outputDir, "summary.txt"), formatReport(report), "utf8");
}

function formatReport(report: PromotionReport): string {
	const lines = [
		"\nWorkflow Promotion Smoke\n",
		`workflow=${report.workflowName} promotion=${report.workflowPromotionOk ? "ok" : "failed"} recommendation=${report.recommendation}`,
		`author=${report.authorModel}`,
		`agent=${report.agentModel}`,
		`output=${report.outputDir}`,
		`savedWorkflow=${report.savedWorkflowPath}`,
		`reasons=${report.reasons.length ? report.reasons.join("; ") : "none"}`,
		"",
	];
	for (const run of report.runs) {
		lines.push(
			`${run.passed ? "PASS" : "FAIL"} ${run.kind} task=${run.taskId} status=${run.status} agents=${run.agentCalls.length}`,
		);
		lines.push(`  worktree=${run.worktreePath ?? "none"}`);
		lines.push(`  checks=${run.checks.map((check) => `${check.command}:${check.ok ? "pass" : "fail"}`).join(", ")}`);
		lines.push(`  diffStat=${run.diffStat.trim() ? run.diffStat.trim().replace(/\n/g, " | ") : "none"}`);
		if (run.reasons.length) lines.push(`  reasons=${run.reasons.join("; ")}`);
	}
	lines.push("");
	return lines.join("\n");
}

function createFixtureRepo(dir: string): void {
	mkdirSync(join(dir, "src"), { recursive: true });
	mkdirSync(join(dir, "test"), { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify(
			{
				name: "kanade-workflow-promotion-fixture",
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
		"# Workflow Promotion Fixture\n\nThe greeting helper currently returns `Hello, world!`.\n",
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
				reject(new Error(`Timeout waiting for workflow promotion task ${taskId}`));
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
		workflowName: "generated_greeting_update",
		outputDir: resolve("eval-artifacts", "workflow-promotion-smoke", stamp),
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
		else if (arg === "--workflow-name") args.workflowName = next();
		else if (arg === "--output-dir") args.outputDir = resolve(next());
		else if (arg === "--timeout-ms") args.timeoutMs = Number(next());
		else if (arg === "--poll-ms") args.pollMs = Number(next());
		else if (arg === "--json") args.json = true;
		else if (arg === "--help" || arg === "-h") usage(0);
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!/^[a-zA-Z0-9_-]+$/.test(args.workflowName))
		throw new Error("--workflow-name must be alphanumeric, hyphen, or underscore");
	return args;
}

function usage(code: number): never {
	console.log(`Usage:
  npm run smoke:workflow-promotion -- [--author-model xiaomi/mimo-v2.5-pro] [--agent-model xiaomi/mimo-v2.5-pro]

Runs a generated workflow on fixture A, saves it, then runs the saved workflow on fixture B.
The Kanade source repository is not modified.

Options:
  --author-model MODEL    Workflow author model (default: xiaomi/mimo-v2.5-pro)
  --agent-model MODEL     Subagent model (default: xiaomi/mimo-v2.5-pro)
  --workflow-name NAME    Saved workflow name (default: generated_greeting_update)
  --output-dir DIR        Persist workflows, diffs, and summary here
  --timeout-ms N          Task timeout (default: 1800000)
  --poll-ms N             Poll interval (default: 5000)
  --json                  Print JSON report
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
