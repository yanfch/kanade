import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/index.ts";
import { HumanGate } from "../human/index.ts";
import { StateStore } from "../store/index.ts";
import { EventBus } from "./event-bus.ts";
import { TaskManager } from "./task-manager.ts";

function setup() {
	const root = mkdtempSync(join(tmpdir(), "kanade-server-"));
	process.env.KANADE_DIR = root;
	const config = loadConfig();
	const store = new StateStore(config.paths.stateDb);
	const events = new EventBus();
	const humanGate = new HumanGate(store, { pollIntervalMs: 5 });
	const manager = new TaskManager(config, store, events, humanGate);
	return { config, store, manager };
}

describe("TaskManager", () => {
	it("runs an inline task to completion", async () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({
				source: "inline",
				script: "export const meta = { name: 'demo', description: 'Demo' }\nreturn { ok: true }",
			});

			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"));
			expect(JSON.parse(manager.get(task.task_id)?.result ?? "null")).toEqual({ ok: true });
		} finally {
			store.close();
		}
	});

	it("pauses for human input and resumes after respond", async () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({
				source: "inline",
				script:
					"export const meta = { name: 'human', description: 'Human' }\nreturn await request_human({ title: 'Approve?' })",
			});

			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("needs_human"));
			const pending = store.listPendingNeedsHuman()[0];
			expect(pending.task_id).toBe(task.task_id);

			manager.respond(task.task_id, pending.request_id, { decision: "approve" });

			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"));
			expect(JSON.parse(manager.get(task.task_id)?.result ?? "null")).toEqual({ decision: "approve" });
		} finally {
			store.close();
		}
	});
});
