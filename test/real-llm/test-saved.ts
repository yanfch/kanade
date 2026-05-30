/**
 * Test saved workflow mode.
 * Save a script, then run it by name.
 *
 * Run: npx tsx test/real-llm/test-saved.ts
 */

import { loadConfig } from "../../src/config/index.ts";
import { HumanGate } from "../../src/human/index.ts";
import { EventBus } from "../../src/server/event-bus.ts";
import { TaskManager } from "../../src/server/task-manager.ts";
import { StateStore } from "../../src/store/index.ts";
import { setupTracing } from "../../src/tracing/index.ts";

const TIMEOUT_MS = 60_000;

async function main() {
	const config = loadConfig();
	const tracing = setupTracing(config);
	const store = new StateStore(config.paths.stateDb);
	const events = new EventBus();
	const humanGate = new HumanGate(store, { pollIntervalMs: 5 });
	const tm = new TaskManager(config, store, events, humanGate, undefined, tracing);

	// 1. Save a workflow
	console.log("=== Saving workflow ===");
	const script = `export const meta = { name: 'list-ts-files', description: 'List TypeScript files in src' }
phase('Explore')
const result = await agent('List all TypeScript files in the src/ directory. Return as JSON array.', {
  label: 'explorer',
  schema: {
    type: 'object',
    properties: { files: { type: 'array', items: { type: 'string' } } },
    required: ['files']
  }
})
return result`;

	tm.putWorkflow("list-ts-files", script);
	console.log("Saved workflow 'list-ts-files'");

	// 2. List saved workflows
	console.log("\n=== Saved workflows ===");
	for (const wf of tm.listWorkflows()) {
		console.log(`  ${wf.name}: ${wf.meta.description}`);
	}

	// 3. Run the saved workflow
	console.log("\n=== Running saved workflow ===");
	const task = tm.create({ source: "saved", workflow_name: "list-ts-files" });
	console.log(`Task: ${task.task_id}`);

	const result = await waitForTask(tm, task.task_id);

	console.log(`Status: ${result.status}`);
	if (result.result) {
		try {
			console.log("Result:", JSON.stringify(JSON.parse(result.result), null, 2).slice(0, 500));
		} catch {
			console.log("Result:", result.result.slice(0, 300));
		}
	}
	if (result.error) console.log(`Error: ${result.error}`);

	await tracing.shutdown();
	store.close();
	process.exit(result.status === "finished" ? 0 : 1);
}

function waitForTask(tm: TaskManager, taskId: string) {
	return new Promise<{ status: string; result: string | null; error: string | null }>((resolve, reject) => {
		const start = Date.now();
		const check = setInterval(() => {
			const row = tm.get(taskId);
			if (row && (row.status === "finished" || row.status === "failed" || row.status === "aborted")) {
				clearInterval(check);
				resolve({ status: row.status, result: row.result, error: row.error });
			}
			if (Date.now() - start > TIMEOUT_MS) {
				clearInterval(check);
				reject(new Error("Timeout"));
			}
		}, 1000);
	});
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
