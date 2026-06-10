/**
 * Real LLM smoke test — verifies the full chain with actual LLM calls.
 *
 * Run: npx tsx test/real-llm/smoke.ts
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
	console.log(
		`Config: agentDir=${config.models.agentDir}, authorModel=${config.defaults.authorModel}, agentModel=${config.defaults.agentModel}`,
	);

	const tracing = setupTracing(config);
	const store = new StateStore(config.paths.stateDb);
	const events = new EventBus();
	const humanGate = new HumanGate(store, { pollIntervalMs: 5 });
	const tm = new TaskManager(config, store, events, humanGate, undefined, tracing);

	// Case 1: Simple agent call — ask LLM to return text
	console.log("\n=== Case 1: Simple agent ===");
	const t1 = tm.create({
		source: "inline",
		script: `export const meta = { name: 'hello', description: 'Say hello' }
return await agent('Reply with exactly: hello world', { label: 'greeter' })`,
	});
	console.log(`Task: ${t1.task_id}`);

	const r1 = await waitForTask(tm, t1.task_id);
	console.log(`Status: ${r1.status}`);
	if (r1.result) {
		const parsed = JSON.parse(r1.result);
		console.log(`Result: ${JSON.stringify(parsed).slice(0, 200)}`);
	}
	if (r1.error) console.log(`Error: ${r1.error}`);

	// Case 2: Structured output — ask LLM to return JSON matching schema
	console.log("\n=== Case 2: Structured output ===");
	const t2 = tm.create({
		source: "inline",
		script: `export const meta = { name: 'structured', description: 'Structured test' }
return await agent('What is 2+2? Reply as JSON.', {
  label: 'math',
  schema: {
    type: 'object',
    properties: { answer: { type: 'number' }, explanation: { type: 'string' } },
    required: ['answer']
  }
})`,
	});
	console.log(`Task: ${t2.task_id}`);

	const r2 = await waitForTask(tm, t2.task_id);
	console.log(`Status: ${r2.status}`);
	if (r2.result) {
		const parsed = JSON.parse(r2.result);
		console.log(`Result: ${JSON.stringify(parsed).slice(0, 300)}`);
	}
	if (r2.error) console.log(`Error: ${r2.error}`);

	// Case 3: Parallel agents
	console.log("\n=== Case 3: Parallel ===");
	const t3 = tm.create({
		source: "inline",
		script: `export const meta = { name: 'parallel', description: 'Parallel test' }
const results = await parallel([
  () => agent('Say "first"', { label: 'a' }),
  () => agent('Say "second"', { label: 'b' }),
])
return { count: results.length, items: results }`,
	});
	console.log(`Task: ${t3.task_id}`);

	const r3 = await waitForTask(tm, t3.task_id);
	console.log(`Status: ${r3.status}`);
	if (r3.result) {
		const parsed = JSON.parse(r3.result);
		console.log(`Result: count=${parsed.count}, items=${JSON.stringify(parsed.items).slice(0, 200)}`);
	}
	if (r3.error) console.log(`Error: ${r3.error}`);

	// Summary
	console.log("\n=== Summary ===");
	const tasks = [t1, t2, t3].map((t) => tm.get(t.task_id));
	for (const task of tasks) {
		console.log(`${task?.id}: ${task?.status}`);
	}

	await tracing.shutdown();
	store.close();
	process.exit(0);
}

function waitForTask(
	tm: TaskManager,
	taskId: string,
	timeoutMs = TIMEOUT_MS,
): Promise<{ status: string; result: string | null; error: string | null }> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const check = setInterval(() => {
			const row = tm.get(taskId);
			if (!row) return;
			if (row.status === "finished" || row.status === "failed" || row.status === "aborted") {
				clearInterval(check);
				resolve({ status: row.status, result: row.result, error: row.error });
			}
			if (Date.now() - start > timeoutMs) {
				clearInterval(check);
				reject(new Error(`Timeout waiting for ${taskId}`));
			}
		}, 500);
	});
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
