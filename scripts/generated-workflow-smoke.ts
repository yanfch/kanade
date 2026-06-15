#!/usr/bin/env tsx
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config/index.ts";
import { HumanGate } from "../src/human/index.ts";
import { EventBus } from "../src/server/event-bus.ts";
import { TaskManager, type TaskOptions } from "../src/server/task-manager.ts";
import type { WorkflowAuthor, WorkflowAuthorGenerateOptions } from "../src/server/workflow-author.ts";
import { StateStore } from "../src/store/index.ts";
import { validateSemanticWorkflowScript } from "../src/workflow-engine/runtime.ts";

interface Args {
	authorModel?: string;
	caseIds: string[];
	outputDir: string;
	timeoutMs: number;
	json: boolean;
	keepWorkspace: boolean;
}

interface SmokeCase {
	id: string;
	name: string;
	workflowSize: "small" | "medium" | "large";
	prompt: string;
	deterministicScript: string;
	expect: {
		status: "finished";
		minAgentCalls: number;
		requiredHelpers: string[];
		requiredEvents: string[];
	};
}

interface SmokeReport {
	schemaVersion: 1;
	generatedAt: string;
	mode: "deterministic-author" | "real-author";
	authorModel?: string;
	workspace: string;
	outputDir: string;
	cases: SmokeCaseReport[];
	summary: {
		passed: number;
		total: number;
	};
}

interface SmokeCaseReport {
	id: string;
	name: string;
	workflowSize: string;
	taskId: string;
	status: string;
	passed: boolean;
	reasons: string[];
	workflowPath: string;
	workflowScriptPath: string;
	semanticWorkflowOk: boolean;
	semanticWorkflowError?: string;
	helperCalls: Record<string, number>;
	eventTypes: string[];
	agentCalls: Array<{ label: string; status: string; phase: string | null; role: string | null; from_cache?: number }>;
	resultPreview: string | null;
	error: string | null;
}

const CASES: SmokeCase[] = [
	{
		id: "small-docs",
		name: "small docs generated workflow",
		workflowSize: "small",
		prompt:
			"Small docs task: clarify one README sentence and validate Markdown formatting. Keep the workflow minimal: implement plus focused validation only.",
		deterministicScript: `export const meta = { name: 'small_docs_smoke', description: 'Small docs generated workflow smoke' };
phase('Implement');
const implementation = await implement('Clarify one README sentence and keep the edit minimal.', { role: 'developer' });
phase('Validate');
const validation = await testChange(implementation, { role: 'tester', guidance: 'Check Markdown formatting only.' });
return { implementation, validation };`,
		expect: {
			status: "finished",
			minAgentCalls: 2,
			requiredHelpers: ["implement", "testChange"],
			requiredEvents: ["task.script_generated", "workflow.phase", "workflow.agent_started", "task.finished"],
		},
	},
	{
		id: "medium-review",
		name: "medium review generated workflow",
		workflowSize: "medium",
		prompt:
			"Medium Kanade task: refine CLI recovery wording, include implementation, reviewer pass, and focused validation. Do not ask for human input.",
		deterministicScript: `export const meta = { name: 'medium_review_smoke', description: 'Medium generated workflow smoke with review' };
phase('Implement');
const implementation = await implement('Refine CLI recovery wording and update focused tests.', { role: 'developer' });
phase('Review');
const review = await reviewChange(implementation, { role: 'reviewer', guidance: 'Review safety wording and test coverage.' });
let candidate = implementation;
if (review.status === 'needs_fix') {
  phase('Fix');
  candidate = await continueImplementation(implementation, { role: 'developer', feedback: review, guidance: 'Address review issues.' });
}
phase('Validate');
const validation = await testChange(candidate, { role: 'tester', guidance: 'Run focused CLI tests.' });
return { implementation, review, candidate, validation };`,
		expect: {
			status: "finished",
			minAgentCalls: 3,
			requiredHelpers: ["implement", "reviewChange", "testChange"],
			requiredEvents: ["task.script_generated", "workflow.agent_completed", "task.finished"],
		},
	},
	{
		id: "large-architecture",
		name: "large architecture generated workflow",
		workflowSize: "large",
		prompt:
			"Large Kanade task: design a settings editor architecture improvement with bounded analysis, implementation, review, and validation. Do not request human input.",
		deterministicScript: `export const meta = { name: 'large_architecture_smoke', description: 'Large generated workflow smoke' };
phase('Analyze');
const analysis = await analyze('Analyze the settings editor architecture and identify the smallest safe implementation plan.', { role: 'planner' });
phase('Implement');
const implementation = await implement('Implement the settings editor improvement using the analysis plan.', { role: 'developer' });
phase('Review');
const review = await reviewChange(implementation, { role: 'reviewer', guidance: 'Review architecture fit, safety, and test coverage.' });
let candidate = implementation;
if (review.status === 'needs_fix') {
  phase('Fix');
  candidate = await continueImplementation(implementation, { role: 'developer', feedback: review, guidance: 'Address review issues.' });
}
phase('Validate');
const validation = await testChange(candidate, { role: 'tester', guidance: 'Run focused settings smoke tests and typecheck.' });
return { analysis, implementation, review, candidate, validation };`,
		expect: {
			status: "finished",
			minAgentCalls: 4,
			requiredHelpers: ["analyze", "implement", "reviewChange", "testChange"],
			requiredEvents: ["task.script_generated", "workflow.phase", "workflow.agent_completed", "task.finished"],
		},
	},
];

class DeterministicWorkflowAuthor implements WorkflowAuthor {
	async generate(prompt: string, options?: WorkflowAuthorGenerateOptions): Promise<string> {
		const workflowSize =
			options?.complexityHint === "complex" ? "large" : options?.complexityHint === "simple" ? "small" : "medium";
		const found = CASES.find((item) => item.workflowSize === workflowSize && prompt.includes(item.prompt.slice(0, 24)));
		return (
			found?.deterministicScript ??
			CASES.find((item) => item.workflowSize === workflowSize)?.deterministicScript ??
			CASES[0].deterministicScript
		);
	}
}

function createMockSessionFactory() {
	const createSession = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
		const sm = options.sessionManager;
		if (sm?.isPersisted()) sm.newSession();
		const session = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "mock generated smoke result" }],
					usage: {
						input: 100,
						output: 40,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 140,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			],
			async prompt(text: string) {
				const tool = options.customTools?.find((item) => item.name === "structured_output");
				if (tool)
					await tool.execute("generated-smoke", mockStructuredResult(text), undefined, undefined, undefined as never);
			},
			async abort() {},
			dispose() {
				if (sm?.isPersisted()) {
					sm.appendMessage({
						role: "assistant",
						content: [{ type: "text", text: "mock generated smoke result" }],
					} as never);
				}
			},
		};
		return { session } as unknown as CreateAgentSessionResult;
	};
	return createSession;
}

function mockStructuredResult(prompt: string): Record<string, unknown> {
	const lower = prompt.toLowerCase();
	const base = {
		status: "done",
		summary: "mock generated smoke result",
		filesChanged: [],
		testsRun: "mock focused checks",
		issues: [],
		warnings: [],
		plan: ["inspect", "implement", "validate"],
		currentArchitecture: "mock current settings architecture",
		identifiedIssues: [],
		currentIssues: [],
		proposedImprovements: ["mock bounded improvement"],
		recommendations: ["mock bounded improvement"],
		affectedFiles: [],
		targetFiles: [],
	};
	if (lower.includes("review")) {
		return { ...base, status: "approved", summary: "mock review approved" };
	}
	if (lower.includes("validat") || lower.includes("test")) {
		return { ...base, status: "passed", summary: "mock validation passed" };
	}
	if (lower.includes("analy")) {
		return { ...base, status: "done", summary: "mock analysis complete" };
	}
	return { ...base, status: "done", summary: "mock implementation complete" };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	mkdirSync(args.outputDir, { recursive: true });
	const workspace = createWorkspace(args.keepWorkspace);
	const config = loadConfig();
	config.models.mode = "kanade";
	config.defaults.taskIdPrefix = "GWS";
	config.defaults.agentTimeoutMs = Math.max(config.defaults.agentTimeoutMs ?? 0, args.timeoutMs);
	config.debug.persistSubagents = true;
	const store = new StateStore(config.paths.stateDb);
	const events = new EventBus();
	const humanGate = new HumanGate(store, { pollIntervalMs: 5 });
	const author = args.authorModel ? undefined : new DeterministicWorkflowAuthor();
	const taskManager = new TaskManager(config, store, events, humanGate, author, undefined, createMockSessionFactory());

	const reports: SmokeCaseReport[] = [];
	try {
		for (const smokeCase of CASES.filter((item) => args.caseIds.includes(item.id))) {
			process.stderr.write(`Running generated workflow smoke ${smokeCase.id}... `);
			const taskOptions: TaskOptions = {
				cwd: workspace,
				workflow_size: smokeCase.workflowSize,
				...(args.authorModel ? { author_model: args.authorModel } : {}),
			};
			const created = taskManager.create({ source: "generated", prompt: smokeCase.prompt, options: taskOptions });
			const task = await waitForTerminal(taskManager, created.task_id, args.timeoutMs);
			const script = readFileSync(created.workflow_path, "utf8");
			const report = buildCaseReport({
				smokeCase,
				taskManager,
				events,
				taskId: created.task_id,
				workflowPath: created.workflow_path,
				script,
			});
			reports.push(report);
			writeFileSync(join(args.outputDir, `${smokeCase.id}.workflow.js`), script, "utf8");
			writeFileSync(join(args.outputDir, `${smokeCase.id}.report.json`), JSON.stringify(report, null, 2), "utf8");
			process.stderr.write(`${report.passed ? "PASS" : "FAIL"} status=${task.status}\n`);
		}
	} finally {
		store.close();
	}

	const summary = { passed: reports.filter((item) => item.passed).length, total: reports.length };
	const fullReport: SmokeReport = {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		mode: args.authorModel ? "real-author" : "deterministic-author",
		...(args.authorModel ? { authorModel: args.authorModel } : {}),
		workspace,
		outputDir: args.outputDir,
		cases: reports,
		summary,
	};
	writeFileSync(join(args.outputDir, "summary.json"), JSON.stringify(fullReport, null, 2), "utf8");
	writeFileSync(join(args.outputDir, "summary.txt"), formatSummary(fullReport), "utf8");
	if (args.json) console.log(JSON.stringify(fullReport, null, 2));
	else console.log(formatSummary(fullReport));
	process.exit(summary.passed === summary.total ? 0 : 1);
}

function buildCaseReport(input: {
	smokeCase: SmokeCase;
	taskManager: TaskManager;
	events: EventBus;
	taskId: string;
	workflowPath: string;
	script: string;
}): SmokeCaseReport {
	const task = input.taskManager.get(input.taskId);
	const agentCalls = input.taskManager.getAgentCalls(input.taskId);
	const taskEvents = input.events.getTaskEvents(input.taskId);
	const helperCalls = countHelpers(input.script);
	const reasons: string[] = [];
	let semanticWorkflowOk = true;
	let semanticWorkflowError: string | undefined;
	try {
		validateSemanticWorkflowScript(input.script);
	} catch (error) {
		semanticWorkflowOk = false;
		semanticWorkflowError = error instanceof Error ? error.message : String(error);
		reasons.push(`workflow validation failed: ${semanticWorkflowError}`);
	}
	if (task?.status !== input.smokeCase.expect.status)
		reasons.push(`expected status ${input.smokeCase.expect.status}, got ${task?.status ?? "missing"}`);
	if (agentCalls.length < input.smokeCase.expect.minAgentCalls)
		reasons.push(`expected at least ${input.smokeCase.expect.minAgentCalls} agent calls, got ${agentCalls.length}`);
	for (const helper of input.smokeCase.expect.requiredHelpers) {
		if ((helperCalls[helper] ?? 0) === 0) reasons.push(`missing helper call: ${helper}`);
	}
	const eventTypes = [...new Set(taskEvents.map((event) => event.type))];
	for (const eventType of input.smokeCase.expect.requiredEvents) {
		if (!eventTypes.includes(eventType)) reasons.push(`missing event: ${eventType}`);
	}
	return {
		id: input.smokeCase.id,
		name: input.smokeCase.name,
		workflowSize: input.smokeCase.workflowSize,
		taskId: input.taskId,
		status: task?.status ?? "missing",
		passed: reasons.length === 0,
		reasons,
		workflowPath: input.workflowPath,
		workflowScriptPath: join(resolve(process.cwd(), "."), input.workflowPath),
		semanticWorkflowOk,
		...(semanticWorkflowError ? { semanticWorkflowError } : {}),
		helperCalls,
		eventTypes,
		agentCalls: agentCalls.map((call) => ({
			label: call.label,
			status: call.status,
			phase: call.phase,
			role: call.role,
			from_cache: call.from_cache,
		})),
		resultPreview: task?.result ? preview(task.result) : null,
		error: task?.error ?? null,
	};
}

function countHelpers(script: string): Record<string, number> {
	const names = [
		"analyze",
		"implement",
		"reviewChange",
		"continueImplementation",
		"testChange",
		"request_human",
		"parallel",
	];
	return Object.fromEntries(
		names.map((name) => [name, (script.match(new RegExp(`\\b${name}\\s*\\(`, "g")) ?? []).length]),
	);
}

function formatSummary(report: SmokeReport): string {
	const lines = [
		"\nGenerated Workflow Smoke\n",
		`mode=${report.mode}${report.authorModel ? ` author=${report.authorModel}` : ""}`,
		`workspace=${report.workspace}`,
		`output=${report.outputDir}`,
		`pass=${report.summary.passed}/${report.summary.total}`,
		"",
	];
	for (const item of report.cases) {
		lines.push(
			`${item.passed ? "PASS" : "FAIL"} ${item.id} ${item.name} status=${item.status} agents=${item.agentCalls.length}`,
		);
		lines.push(
			`  helpers=${Object.entries(item.helperCalls)
				.filter(([, count]) => count > 0)
				.map(([name, count]) => `${name}:${count}`)
				.join(", ")}`,
		);
		if (item.reasons.length) lines.push(`  reasons=${item.reasons.join("; ")}`);
	}
	lines.push("");
	return lines.join("\n");
}

function waitForTerminal(taskManager: TaskManager, taskId: string, timeoutMs: number) {
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
				reject(new Error(`Timeout waiting for generated workflow task ${taskId}`));
			}
		}, 100);
	});
}

function createWorkspace(keepWorkspace: boolean): string {
	const root = mkdtempSync(join(tmpdir(), "kanade-generated-smoke-"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "echo smoke" } }, null, 2), "utf8");
	writeFileSync(
		join(root, "README.md"),
		"# Generated Smoke\n\nThis fixture is used by Kanade generated workflow smoke tests.\n",
		"utf8",
	);
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "index.ts"), "export const smoke = true;\n", "utf8");
	if (keepWorkspace) writeFileSync(join(root, ".keep"), "workspace intentionally kept\n", "utf8");
	return root;
}

function parseArgs(argv: string[]): Args {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const args: Args = {
		caseIds: CASES.map((item) => item.id),
		outputDir: resolve("eval-artifacts", "generated-workflow-smoke", stamp),
		timeoutMs: 5 * 60 * 1000,
		json: false,
		keepWorkspace: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (!value) throw new Error(`${arg} requires a value`);
			return value;
		};
		if (arg === "--author-model") args.authorModel = next();
		else if (arg === "--case") args.caseIds = next().split(",").filter(Boolean);
		else if (arg === "--output-dir") args.outputDir = resolve(next());
		else if (arg === "--timeout-ms") args.timeoutMs = Number(next());
		else if (arg === "--json") args.json = true;
		else if (arg === "--keep-workspace") args.keepWorkspace = true;
		else if (arg === "--help" || arg === "-h") usage(0);
		else throw new Error(`Unknown argument: ${arg}`);
	}
	const unknown = args.caseIds.filter((id) => !CASES.some((item) => item.id === id));
	if (unknown.length) throw new Error(`Unknown case(s): ${unknown.join(", ")}`);
	return args;
}

function usage(code: number): never {
	console.log(`Usage:
  npm run smoke:generated-workflow -- [--author-model xiaomi/mimo-v2.5-pro] [--case small-docs,medium-review,large-architecture]

Options:
  --author-model MODEL   Use a real workflow author model; subagents remain mocked
  --case IDS             Comma-separated case ids (default: all)
  --output-dir DIR       Persist reports and generated scripts here
  --timeout-ms N         Per-task timeout
  --json                 Print JSON report
  --keep-workspace       Leave a marker in the temporary fixture workspace
`);
	process.exit(code);
}

function preview(value: string, limit = 240): string {
	return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

main().catch((error) => {
	console.error("FATAL:", error);
	process.exit(1);
});
