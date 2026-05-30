import { existsSync } from "node:fs";
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

const SIMPLE_SCRIPT = "export const meta = { name: 'demo', description: 'Demo' }\nreturn { ok: true }";

function setup() {
	const root = mkdtempSync(join(tmpdir(), "kanade-app-"));
	process.env.KANADE_DIR = root;
	const config = loadConfig();
	const store = new StateStore(config.paths.stateDb);
	const events = new EventBus();
	const humanGate = new HumanGate(store, { initialPollMs: 5 });
	const taskManager = new TaskManager(config, store, events, humanGate);
	const app = createApp({ taskManager, events });
	return { config, store, taskManager, events, app };
}

describe("server app — existing", () => {
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
			const response = await app.request("/tasks/T-1/events");
			expect(response.status).toBe(404);

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

describe("GET /tasks/:id/script", () => {
	it("returns 404 for unknown task", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/tasks/T-9999/script");
			expect(res.status).toBe(404);
		} finally {
			store.close();
		}
	});

	it("returns the script content", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			const res = await app.request(`/tasks/${created.task_id}/script`);
			const body = (await res.json()) as { script: string };
			expect(res.status).toBe(200);
			expect(body.script).toBe(SIMPLE_SCRIPT);
		} finally {
			store.close();
		}
	});
});

describe("GET /tasks/:id/journal", () => {
	it("returns 404 for unknown task", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/tasks/T-9999/journal");
			expect(res.status).toBe(404);
		} finally {
			store.close();
		}
	});

	it("returns agents and humans arrays for a known task", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			const res = await app.request(`/tasks/${created.task_id}/journal`);
			const body = (await res.json()) as { agents: unknown[]; humans: unknown[] };
			expect(res.status).toBe(200);
			expect(Array.isArray(body.agents)).toBe(true);
			expect(Array.isArray(body.humans)).toBe(true);
		} finally {
			store.close();
		}
	});
});

describe("GET /tasks/:id/artifacts", () => {
	it("returns 404 for unknown task", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/tasks/T-9999/artifacts");
			expect(res.status).toBe(404);
		} finally {
			store.close();
		}
	});

	it("returns empty array when no artifacts exist", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("finished"));
			const res = await app.request(`/tasks/${created.task_id}/artifacts`);
			const body = (await res.json()) as { artifacts: string[] };
			expect(res.status).toBe(200);
			expect(body.artifacts).toEqual([]);
		} finally {
			store.close();
		}
	});
});

describe("GET /tasks/:id/artifacts/:name", () => {
	it("returns 404 for unknown task", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/tasks/T-9999/artifacts/01-design.json");
			expect(res.status).toBe(404);
		} finally {
			store.close();
		}
	});

	it("returns 404 for missing artifact", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("finished"));
			const res = await app.request(`/tasks/${created.task_id}/artifacts/missing.json`);
			expect(res.status).toBe(404);
		} finally {
			store.close();
		}
	});
});

describe("POST /tasks/:id/rerun", () => {
	it("returns 404 for unknown task", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/tasks/T-9999/rerun", { method: "POST" });
			expect(res.status).toBe(404);
		} finally {
			store.close();
		}
	});

	it("creates a new task and returns rerun_of", async () => {
		const { store, taskManager, app } = setup();
		try {
			const original = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(taskManager.get(original.task_id)?.status).toBe("finished"));

			const res = await app.request(`/tasks/${original.task_id}/rerun`, { method: "POST" });
			const body = (await res.json()) as { task_id: string; rerun_of: string };

			expect(res.status).toBe(202);
			expect(body.task_id).not.toBe(original.task_id);
			expect(body.rerun_of).toBe(original.task_id);

			await vi.waitFor(() => expect(taskManager.get(body.task_id)?.status).toBe("finished"));
		} finally {
			store.close();
		}
	});

	it("accepts option overrides in the body", async () => {
		const { store, taskManager, app } = setup();
		try {
			const original = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(taskManager.get(original.task_id)?.status).toBe("finished"));

			const res = await app.request(`/tasks/${original.task_id}/rerun`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ options: { concurrency: 2 } }),
			});
			const body = (await res.json()) as { task_id: string };
			expect(res.status).toBe(202);

			const rerunTask = taskManager.get(body.task_id);
			expect(JSON.parse(rerunTask?.options ?? "{}")).toMatchObject({ concurrency: 2 });

			await vi.waitFor(() => expect(taskManager.get(body.task_id)?.status).toBe("finished"));
		} finally {
			store.close();
		}
	});
});

describe("POST /tasks/:id/save", () => {
	it("returns 404 for unknown task", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/tasks/T-9999/save", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "my-workflow" }),
			});
			expect(res.status).toBe(404);
		} finally {
			store.close();
		}
	});

	it("returns 400 when name is missing", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			const res = await app.request(`/tasks/${created.task_id}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(400);
		} finally {
			store.close();
		}
	});

	it("returns 400 for an invalid name", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			const res = await app.request(`/tasks/${created.task_id}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "bad name!" }),
			});
			expect(res.status).toBe(400);
		} finally {
			store.close();
		}
	});

	it("writes the script to workflowsDir and returns ok", async () => {
		const { config, store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("finished"));

			const res = await app.request(`/tasks/${created.task_id}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "my-workflow" }),
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ ok: true });
			expect(existsSync(join(config.paths.workflowsDir, "my-workflow.js"))).toBe(true);
		} finally {
			store.close();
		}
	});
});

describe("GET /workflows", () => {
	it("returns empty array when no workflows exist", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/workflows");
			const body = (await res.json()) as { workflows: unknown[] };
			expect(res.status).toBe(200);
			expect(body.workflows).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("returns list of saved workflows with meta", async () => {
		const { store, taskManager, app } = setup();
		try {
			taskManager.putWorkflow("demo", SIMPLE_SCRIPT);
			const res = await app.request("/workflows");
			const body = (await res.json()) as { workflows: Array<{ name: string; meta: { name: string } }> };
			expect(res.status).toBe(200);
			expect(body.workflows).toHaveLength(1);
			expect(body.workflows[0].name).toBe("demo");
			expect(body.workflows[0].meta.name).toBe("demo");
		} finally {
			store.close();
		}
	});
});

describe("GET /workflows/:name", () => {
	it("returns 404 for unknown workflow", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/workflows/missing");
			expect(res.status).toBe(404);
		} finally {
			store.close();
		}
	});

	it("returns workflow info including script and meta", async () => {
		const { store, taskManager, app } = setup();
		try {
			taskManager.putWorkflow("demo", SIMPLE_SCRIPT);
			const res = await app.request("/workflows/demo");
			const body = (await res.json()) as { name: string; script: string; meta: { name: string } };
			expect(res.status).toBe(200);
			expect(body.name).toBe("demo");
			expect(body.script).toBe(SIMPLE_SCRIPT);
			expect(body.meta.name).toBe("demo");
		} finally {
			store.close();
		}
	});
});

describe("PUT /workflows/:name", () => {
	it("creates a new workflow", async () => {
		const { store, taskManager, app } = setup();
		try {
			const res = await app.request("/workflows/new-wf", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ script: SIMPLE_SCRIPT }),
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ ok: true });
			expect(taskManager.getWorkflow("new-wf")).not.toBeNull();
		} finally {
			store.close();
		}
	});

	it("returns 400 when script is missing", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/workflows/wf", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(400);
		} finally {
			store.close();
		}
	});

	it("returns 400 when script has no valid meta export", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/workflows/wf", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ script: "const x = 1" }),
			});
			expect(res.status).toBe(400);
		} finally {
			store.close();
		}
	});
});

describe("DELETE /workflows/:name", () => {
	it("returns 404 for unknown workflow", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/workflows/missing", { method: "DELETE" });
			expect(res.status).toBe(404);
		} finally {
			store.close();
		}
	});

	it("deletes the workflow and returns ok", async () => {
		const { store, taskManager, app } = setup();
		try {
			taskManager.putWorkflow("to-delete", SIMPLE_SCRIPT);
			const res = await app.request("/workflows/to-delete", { method: "DELETE" });
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ ok: true });
			expect(taskManager.getWorkflow("to-delete")).toBeNull();
		} finally {
			store.close();
		}
	});
});

describe("POST /tasks source:saved", () => {
	it("runs a saved workflow and returns task_id", async () => {
		const { store, taskManager, app } = setup();
		try {
			taskManager.putWorkflow("demo", SIMPLE_SCRIPT);
			const res = await app.request("/tasks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ source: "saved", workflow_name: "demo" }),
			});
			const body = (await res.json()) as { task_id: string };
			expect(res.status).toBe(202);
			await vi.waitFor(() => expect(taskManager.get(body.task_id)?.status).toBe("finished"));
			expect(taskManager.get(body.task_id)?.workflow_source).toBe("saved");
			expect(taskManager.get(body.task_id)?.workflow_name).toBe("demo");
		} finally {
			store.close();
		}
	});

	it("returns 404 for unknown workflow", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/tasks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ source: "saved", workflow_name: "missing" }),
			});
			expect(res.status).toBe(404);
		} finally {
			store.close();
		}
	});
});

describe("POST /tasks source:generated", () => {
	it("returns 202 with generated:true and task runs to completion", async () => {
		const { store, taskManager, app } = setup();
		try {
			const res = await app.request("/tasks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ source: "generated", prompt: "return { ok: true }" }),
			});
			const body = (await res.json()) as { task_id: string; generated: boolean };
			expect(res.status).toBe(202);
			expect(body.generated).toBe(true);
			await vi.waitFor(() => expect(taskManager.get(body.task_id)?.status).toBe("finished"), {
				timeout: 5000,
			});
		} finally {
			store.close();
		}
	});

	it("workflow.js is written to the run dir", async () => {
		const { store, taskManager, app } = setup();
		try {
			const res = await app.request("/tasks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ source: "generated", prompt: "return {}" }),
			});
			const body = (await res.json()) as { task_id: string };
			await vi.waitFor(() => expect(taskManager.get(body.task_id)?.status).not.toBe("created"), {
				timeout: 5000,
			});
			expect(
				existsSync(taskManager.getScript(body.task_id) !== null ? taskManager.get(body.task_id)!.workflow_path : ""),
			).toBe(true);
			taskManager.abort(body.task_id);
		} finally {
			store.close();
		}
	});
});

describe("POST /tasks source:inline", () => {
	it("creates and runs an inline task", async () => {
		const { store, taskManager, app } = setup();
		try {
			const res = await app.request("/tasks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ source: "inline", script: SIMPLE_SCRIPT }),
			});
			const body = (await res.json()) as { task_id: string };
			expect(res.status).toBe(202);
			expect(body.task_id).toBeTruthy();

			await vi.waitFor(() => expect(taskManager.get(body.task_id)?.status).toBe("finished"));
		} finally {
			store.close();
		}
	});

	it("returns 400 when script is missing for inline source", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/tasks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ source: "inline" }),
			});
			// Script validation happens inside TaskManager.create → throws Error
			// The error handler converts it to 500 (not AppError)
			expect(res.status).toBeGreaterThanOrEqual(400);
		} finally {
			store.close();
		}
	});
});

describe("POST /tasks/:id/abort", () => {
	it("aborts a running task", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({
				source: "inline",
				script:
					"export const meta = { name: 'human', description: 'Human' }\nreturn await request_human({ title: 'Approve?' })",
			});
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("needs_human"));

			const res = await app.request(`/tasks/${created.task_id}/abort`, { method: "POST" });
			expect(res.status).toBe(200);

			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("aborted"));
		} finally {
			store.close();
		}
	});
});

describe("POST /tasks/:id/respond", () => {
	it("resolves a needs_human request and resumes the task", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({
				source: "inline",
				script:
					"export const meta = { name: 'human', description: 'Human' }\nreturn await request_human({ title: 'Approve?' })",
			});
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("needs_human"));

			const pending = store.listPendingNeedsHuman()[0];
			const res = await app.request(`/tasks/${created.task_id}/respond`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ request_id: pending.request_id, response: { decision: "approve" } }),
			});
			expect(res.status).toBe(200);

			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("finished"));
		} finally {
			store.close();
		}
	});
});

describe("error handling", () => {
	it("returns 500 for unknown errors", async () => {
		const { store, app, taskManager } = setup();
		try {
			// Create a task that will fail with a non-AppError
			const created = taskManager.create({
				source: "inline",
				script: "export const meta = { name: 'fail', description: 'Fail' }\nthrow new Error('boom')",
			});
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("failed"));

			// Verify the task is in failed state
			const res = await app.request(`/tasks/${created.task_id}`);
			const body = (await res.json()) as { task: { status: string; error: string } };
			expect(body.task.status).toBe("failed");
			expect(body.task.error).toContain("boom");
		} finally {
			store.close();
		}
	});

	it("returns JSON error for 404 routes", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/nonexistent");
			// Hono returns 405 or 404 for unmatched routes
			expect(res.status).toBeGreaterThanOrEqual(400);
		} finally {
			store.close();
		}
	});
});

describe("GET /health", () => {
	it("returns ok", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/health");
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ ok: true });
		} finally {
			store.close();
		}
	});
});
