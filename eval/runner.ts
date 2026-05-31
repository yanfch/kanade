/**
 * Eval runner — executes eval cases against the real TaskManager
 * and produces scored results.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config/index.ts";
import { HumanGate } from "../src/human/index.ts";
import { EventBus } from "../src/server/event-bus.ts";
import { TaskManager } from "../src/server/task-manager.ts";
import { StateStore } from "../src/store/index.ts";
import { scoreCase } from "./scorer.ts";
import type { EvalCase, EvalResult, RunMetrics } from "./types.ts";

const TIMEOUT_MS = 120_000;

export interface EvalRunnerOptions {
	/** Mock session factory for testing. If omitted, uses real LLM. */
	createSession?: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
	/** Working directory override */
	cwd?: string;
}

/**
 * Run a single eval case and return the scored result.
 */
export async function runCase(evalCase: EvalCase, opts: EvalRunnerOptions = {}): Promise<EvalResult> {
	const root = mkdtempSync(join(tmpdir(), "kanade-eval-"));
	process.env.KANADE_DIR = root;
	const config = loadConfig();
	const store = new StateStore(config.paths.stateDb);
	const events = new EventBus();
	const humanGate = new HumanGate(store, { pollIntervalMs: 5 });
	const tm = new TaskManager(config, store, events, humanGate, undefined, undefined, opts.createSession);

	try {
		let taskResult: { task_id: string };

		if (evalCase.source === "inline" && evalCase.script) {
			taskResult = tm.create({ source: "inline", script: evalCase.script, args: evalCase.args });
		} else if (evalCase.source === "saved" && evalCase.workflow_name) {
			taskResult = tm.create({ source: "saved", workflow_name: evalCase.workflow_name, args: evalCase.args });
		} else if (evalCase.source === "generated" && evalCase.prompt) {
			taskResult = tm.create({ source: "generated", prompt: evalCase.prompt, args: evalCase.args });
		} else {
			return {
				caseId: evalCase.id,
				caseName: evalCase.name,
				category: evalCase.category,
				passed: false,
				score: 0,
				breakdown: { completion: 0, correctness: 0, efficiency: 0 },
				metrics: { agentCalls: 0, durationMs: 0, tokensUsed: 0, journalHits: 0, phases: [] },
				actualStatus: "error",
				error: `Invalid case config: source=${evalCase.source} but missing required field`,
			};
		}

		// Wait for task to finish
		const row = await waitForTask(tm, taskResult.task_id);
		const task = tm.get(taskResult.task_id);

		// Collect metrics
		const journal = tm.getJournal(taskResult.task_id);
		const metrics: RunMetrics = {
			agentCalls: journal?.agents?.length ?? 0,
			durationMs: row.durationMs,
			tokensUsed: 0, // TODO: extract from tracing
			journalHits: 0, // TODO: extract from journal
			phases: task?.phases?.split(",").filter(Boolean) ?? [],
		};

		// Parse result
		let result: unknown = null;
		try {
			result = row.result ? JSON.parse(row.result) : null;
		} catch {
			result = row.result;
		}

		return scoreCase(evalCase, { status: row.status, result }, metrics);
	} catch (err) {
		return {
			caseId: evalCase.id,
			caseName: evalCase.name,
			category: evalCase.category,
			passed: false,
			score: 0,
			breakdown: { completion: 0, correctness: 0, efficiency: 0 },
			metrics: { agentCalls: 0, durationMs: 0, tokensUsed: 0, journalHits: 0, phases: [] },
			actualStatus: "error",
			error: err instanceof Error ? err.message : String(err),
		};
	} finally {
		store.close();
	}
}

/**
 * Run all cases in a suite and return results.
 */
export async function runSuite(cases: EvalCase[], opts: EvalRunnerOptions = {}): Promise<EvalResult[]> {
	const results: EvalResult[] = [];
	for (const evalCase of cases) {
		process.stderr.write(`  Running ${evalCase.id}: ${evalCase.name}...`);
		const result = await runCase(evalCase, opts);
		process.stderr.write(result.passed ? ` ${GREEN}PASS${RESET}\n` : ` ${RED}FAIL${RESET}\n`);
		results.push(result);
	}
	return results;
}

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function waitForTask(
	tm: TaskManager,
	taskId: string,
): Promise<{ status: string; result: string | null; durationMs: number }> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const check = setInterval(() => {
			const row = tm.get(taskId);
			if (!row) return;
			if (row.status === "finished" || row.status === "failed" || row.status === "aborted") {
				clearInterval(check);
				resolve({
					status: row.status,
					result: row.result,
					durationMs: Date.now() - start,
				});
			}
			if (Date.now() - start > TIMEOUT_MS) {
				clearInterval(check);
				reject(new Error(`Timeout waiting for ${taskId}`));
			}
		}, 500);
	});
}
