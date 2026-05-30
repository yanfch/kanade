import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/index.ts";
import { HumanGate } from "../human/index.ts";
import { StateStore } from "../store/index.ts";
import { createApp } from "./app.ts";
import { EventBus } from "./event-bus.ts";
import { TaskManager } from "./task-manager.ts";

function setup() {
	const root = mkdtempSync(join(tmpdir(), "kanade-app-"));
	process.env.KANADE_DIR = root;
	const config = loadConfig();
	const store = new StateStore(config.paths.stateDb);
	const events = new EventBus();
	const humanGate = new HumanGate(store, { pollIntervalMs: 5 });
	const taskManager = new TaskManager(config, store, events, humanGate);
	const app = createApp({ taskManager, events });
	return { store, taskManager, events, app };
}

describe("server app", () => {
	it("lists pending human requests through /inbox", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({
				source: "inline",
				script:
					"export const meta = { name: 'human', description: 'Human' }\nreturn await request_human({ title: 'Approve?', options: ['yes'] })",
			});
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("needs_human"));

			const response = await app.request("/inbox");
			const body = (await response.json()) as { requests: Array<Record<string, unknown>> };

			expect(response.status).toBe(200);
			expect(body.requests).toHaveLength(1);
			expect(body.requests[0]).toMatchObject({
				task_id: created.task_id,
				payload: { title: "Approve?", options: ["yes"] },
				status: "pending",
			});
			taskManager.abort(created.task_id);
		} finally {
			store.close();
		}
	});

	it("rejects missing task event streams and supports task event subscriptions", async () => {
		const { store, events, app } = setup();
		try {
			const controller = new AbortController();
			const responsePromise = app.request("/tasks/T-1/events", { signal: controller.signal });
			const response = await responsePromise;
			expect(response.status).toBe(404);

			// Existing task-specific streams are covered by EventBus semantics here.
			const received: string[] = [];
			const off = events.onTask("T-1", (event) => received.push(event.type));
			events.emit("task.test", { ok: true }, "T-1");
			off();
			expect(received).toEqual(["task.test"]);
		} finally {
			store.close();
		}
	});
});
