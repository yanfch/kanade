/**
 * Test generated workflow mode.
 * LLM writes a workflow script from a prompt, then runs it.
 *
 * Run: npx tsx test/real-llm/test-generated.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "../../src/config/index.ts";
import { HumanGate } from "../../src/human/index.ts";
import { EventBus } from "../../src/server/event-bus.ts";
import { TaskManager } from "../../src/server/task-manager.ts";
import { StateStore } from "../../src/store/index.ts";
import { setupTracing } from "../../src/tracing/index.ts";

const TIMEOUT_MS = 90_000;

async function main() {
	const config = loadConfig();
	console.log(`Model: ${config.defaults.model}`);

	const tracing = setupTracing(config);
	const store = new StateStore(config.paths.stateDb);
	const events = new EventBus();
	const humanGate = new HumanGate(store, { pollIntervalMs: 5 });
	const tm = new TaskManager(config, store, events, humanGate, undefined, tracing);

	console.log("\nPrompt: 列出 src/ 下的文件夹\n");

	const task = tm.create({
		source: "generated",
		prompt: "简单任务：列出 src/ 目录下的所有子文件夹名称。只用 1 个 agent，不要并发。返回 JSON 数组。",
		options: { concurrency: 1 },
	});
	console.log(`Task: ${task.task_id}`);
	console.log(`Generated: ${task.generated}`);
	console.log(`Workflow path: ${task.workflow_path}`);

	// Wait for script generation then completion
	const result = await waitForTask(tm, task.task_id);

	// Read the generated script
	if (existsSync(task.workflow_path)) {
		const script = readFileSync(task.workflow_path, "utf8");
		console.log("\n--- Generated script ---");
		console.log(script.slice(0, 1000));
		if (script.length > 1000) console.log("... (truncated)");
		console.log("--- end ---\n");
	}

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
