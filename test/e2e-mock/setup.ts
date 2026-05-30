/**
 * E2E test setup: real TaskManager with injected mock session.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../src/config/index.ts";
import { HumanGate } from "../../src/human/index.ts";
import { EventBus } from "../../src/server/event-bus.ts";
import { TaskManager } from "../../src/server/task-manager.ts";
import { StateStore } from "../../src/store/index.ts";

export interface E2EContext {
	config: ReturnType<typeof loadConfig>;
	store: StateStore;
	events: EventBus;
	taskManager: TaskManager;
	cleanup(): void;
}

/**
 * Create a real TaskManager with a mock session factory injected.
 * Everything runs real code — only createAgentSession is mocked.
 */
export function createE2EContext(
	createSession: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>,
): E2EContext {
	const root = mkdtempSync(join(tmpdir(), "kanade-e2e-"));
	process.env.KANADE_DIR = root;
	const config = loadConfig();
	const store = new StateStore(config.paths.stateDb);
	const events = new EventBus();
	const humanGate = new HumanGate(store, { pollIntervalMs: 5 });
	const taskManager = new TaskManager(config, store, events, humanGate, undefined, undefined, createSession);

	return {
		config,
		store,
		events,
		taskManager,
		cleanup() {
			store.close();
		},
	};
}

/**
 * Wait for a task to reach target status.
 */
export async function waitForTask(
	taskManager: TaskManager,
	taskId: string,
	targetStatus = "finished",
	timeoutMs = 10_000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const task = taskManager.get(taskId);
		if (task?.status === targetStatus) return;
		if (task?.status === "failed" && targetStatus !== "failed") {
			throw new Error(`Task failed: ${task.error}`);
		}
		if (task?.status === "aborted" && targetStatus !== "aborted") {
			throw new Error("Task aborted unexpectedly");
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`Timeout waiting for task ${taskId} to reach ${targetStatus}`);
}
