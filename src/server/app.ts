import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { KanadeConfig } from "../config/config.ts";
import type { TaskStatus } from "../store/index.ts";
import { AppError } from "./errors.ts";
import type { EventBus, ServerEvent } from "./event-bus.ts";
import type { CreateTaskInput } from "./task-manager.ts";
import type { TaskManager } from "./task-manager.ts";

export interface AppContext {
	taskManager: TaskManager;
	events: EventBus;
	config?: KanadeConfig;
}

export function createApp(ctx: AppContext): Hono {
	const app = new Hono();

	// Request logging middleware
	app.use("*", async (c, next) => {
		const start = Date.now();
		await next();
		const duration = Date.now() - start;
		const status = c.res.status;
		// Skip noisy endpoints
		if (c.req.path === "/health" || c.req.path.endsWith("/events")) return;
		console.log(`${c.req.method} ${c.req.path} ${status} ${duration}ms`);
	});

	app.onError((err, c) => {
		if (err instanceof AppError) return c.json({ error: err.message }, err.status);
		return c.json({ error: err.message }, 500);
	});

	app.get("/health", (c) => c.json({ ok: true }));

	app.post("/tasks", async (c) => {
		const body = await c.req.json();
		const result = ctx.taskManager.create(body);
		return c.json(result, 202);
	});

	app.get("/workflows", (c) => {
		return c.json({ workflows: ctx.taskManager.listWorkflows() });
	});

	app.post("/workflows/generate", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new AppError("prompt is required", 400);
		const options =
			body.options && typeof body.options === "object" ? (body.options as CreateTaskInput["options"]) : undefined;
		const result = await ctx.taskManager.generateWorkflow(body.prompt, options);
		return c.json(result);
	});

	app.get("/workflows/:name", (c) => {
		const workflow = ctx.taskManager.getWorkflow(c.req.param("name"));
		if (!workflow) return c.json({ error: "Workflow not found" }, 404);
		return c.json(workflow);
	});

	app.put("/workflows/:name", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const { script } = body;
		if (typeof script !== "string" || !script.trim()) throw new AppError("script is required", 400);
		try {
			ctx.taskManager.putWorkflow(c.req.param("name"), script);
		} catch (err) {
			throw new AppError(err instanceof Error ? err.message : String(err), 400);
		}
		return c.json({ ok: true });
	});

	app.delete("/workflows/:name", (c) => {
		const deleted = ctx.taskManager.deleteWorkflow(c.req.param("name"));
		if (!deleted) return c.json({ error: "Workflow not found" }, 404);
		return c.json({ ok: true });
	});

	app.get("/tasks", (c) => {
		const status = c.req.query("status") as TaskStatus | undefined;
		return c.json({ tasks: ctx.taskManager.list(status) });
	});

	app.get("/tasks/:id", (c) => {
		const taskId = c.req.param("id");
		const task = ctx.taskManager.get(taskId);
		if (!task) return c.json({ error: "Task not found" }, 404);
		const usage = ctx.taskManager.getUsage(taskId);
		const { usage: _rawUsage, ...taskBody } = task;
		return c.json({ task: taskBody, usage });
	});

	app.get("/inbox", (c) => c.json({ requests: ctx.taskManager.inbox().map(formatInboxRow) }));

	app.get("/events", (c) =>
		streamSSE(c, async (stream) => {
			const off = ctx.events.onAny((event) => void writeEvent(stream, event));
			await waitForClose(c.req.raw.signal, off, stream);
		}),
	);

	app.get("/tasks/:id/events", (c) => {
		const taskId = c.req.param("id");
		if (!ctx.taskManager.get(taskId)) return c.json({ error: "Task not found" }, 404);
		return streamSSE(c, async (stream) => {
			const { past, unsubscribe } = ctx.events.replayAndSubscribe(taskId, (event) => void writeEvent(stream, event));
			// Replay stored events
			for (const event of past) {
				await writeEvent(stream, event);
			}
			await waitForClose(c.req.raw.signal, unsubscribe, stream);
		});
	});

	app.post("/tasks/:id/respond", async (c) => {
		const taskId = c.req.param("id");
		const body = await c.req.json();
		if (typeof body.request_id !== "string") throw new Error("request_id is required");
		ctx.taskManager.respond(taskId, body.request_id, body.response ?? body);
		return c.json({ ok: true });
	});

	app.post("/tasks/:id/abort", async (c) => {
		await ctx.taskManager.abort(c.req.param("id"));
		return c.json({ ok: true });
	});

	app.get("/tasks/:id/journal", (c) => {
		const entries = ctx.taskManager.getJournal(c.req.param("id"));
		if (!entries) return c.json({ error: "Task not found" }, 404);
		return c.json(entries);
	});

	app.get("/tasks/:id/script", (c) => {
		const script = ctx.taskManager.getScript(c.req.param("id"));
		if (script === null) return c.json({ error: "Task not found" }, 404);
		return c.json({ script });
	});

	app.get("/tasks/:id/artifacts", (c) => {
		const list = ctx.taskManager.getArtifacts(c.req.param("id"));
		if (!list) return c.json({ error: "Task not found" }, 404);
		return c.json({ artifacts: list });
	});

	app.get("/tasks/:id/artifacts/:name", (c) => {
		const content = ctx.taskManager.getArtifact(c.req.param("id"), c.req.param("name"));
		if (content === null) return c.json({ error: "Not found" }, 404);
		return c.json(content);
	});

	app.get("/tasks/:id/snapshot", (c) => {
		const snapshot = ctx.taskManager.getSnapshot(c.req.param("id"));
		if (!snapshot) return c.json({ error: "Not found" }, 404);
		return c.json({ snapshot });
	});

	app.get("/tasks/:id/worktrees", (c) => {
		const taskId = c.req.param("id");
		if (!ctx.taskManager.get(taskId)) return c.json({ error: "Task not found" }, 404);
		const worktrees = ctx.taskManager.getWorktrees(taskId);
		return c.json({ worktrees });
	});

	app.post("/tasks/:id/rerun", async (c) => {
		if (!ctx.taskManager.get(c.req.param("id"))) return c.json({ error: "Task not found" }, 404);
		const body = (await c.req.json().catch(() => ({}))) as {
			args?: unknown;
			options?: Partial<CreateTaskInput["options"]>;
		};
		const result = ctx.taskManager.rerun(c.req.param("id"), body);
		return c.json(result, 202);
	});

	app.post("/tasks/:id/save", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const { name } = body;
		if (typeof name !== "string" || !name.trim()) throw new AppError("name is required", 400);
		if (!/^[a-zA-Z0-9_-]+$/.test(name))
			throw new AppError("name must contain only alphanumeric characters, hyphens, and underscores", 400);
		if (!ctx.taskManager.get(c.req.param("id"))) return c.json({ error: "Task not found" }, 404);
		ctx.taskManager.save(c.req.param("id"), name);
		return c.json({ ok: true });
	});

	app.post("/tasks/:id/merge", async (c) => {
		const result = await ctx.taskManager.merge(c.req.param("id"));
		if (!result.success) return c.json({ error: result.error }, 400);
		return c.json(result);
	});

	app.post("/tasks/:id/reject", async (c) => {
		await ctx.taskManager.reject(c.req.param("id"));
		return c.json({ ok: true });
	});

	app.post("/tasks/:id/iterate", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as {
			instructions?: string;
			args?: unknown;
		};
		const result = ctx.taskManager.iterate(c.req.param("id"), body);
		return c.json(result, 202);
	});

	// ── Subagent session routes ──────────────────────────────────────────────

	app.get("/tasks/:id/sessions", (c) => {
		const taskId = c.req.param("id");
		if (!ctx.taskManager.get(taskId)) return c.json({ error: "Task not found" }, 404);
		const config = ctx.config;
		if (!config) return c.json({ error: "Config not available" }, 500);
		const subagentsDir = join(config.paths.runsDir, taskId, "debug", "subagents");
		if (!existsSync(subagentsDir)) return c.json({ sessions: [] });
		// Labels are sanitized directory names (original labels may contain special chars)
		const labels = readdirSync(subagentsDir).filter((name) => {
			const fullPath = join(subagentsDir, name);
			try {
				return existsSync(fullPath) && readdirSync(fullPath).some((f) => f.endsWith(".jsonl"));
			} catch {
				return false;
			}
		});
		const sessions = labels.map((label) => {
			const labelDir = join(subagentsDir, label);
			const files = readdirSync(labelDir).filter((f) => f.endsWith(".jsonl"));
			return { label, files };
		});
		return c.json({ sessions });
	});

	app.get("/tasks/:id/sessions/:label", (c) => {
		const taskId = c.req.param("id");
		const label = c.req.param("label");
		if (!ctx.taskManager.get(taskId)) return c.json({ error: "Task not found" }, 404);
		const config = ctx.config;
		if (!config) return c.json({ error: "Config not available" }, 500);
		const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_");
		const labelDir = join(config.paths.runsDir, taskId, "debug", "subagents", safeLabel);
		if (!existsSync(labelDir)) return c.json({ error: "Session not found" }, 404);
		const files = readdirSync(labelDir).filter((f) => f.endsWith(".jsonl"));
		if (!files.length) return c.json({ error: "Session not found" }, 404);
		// Return the most recent session file
		const sessionFile = join(labelDir, files[files.length - 1]);
		const content = readFileSync(sessionFile, "utf8");
		const entries = content
			.trim()
			.split("\n")
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter(Boolean);
		return c.json({ label, entries, file: files[files.length - 1] });
	});

	return app;
}

function formatInboxRow(row: ReturnType<TaskManager["inbox"]>[number]) {
	return {
		request_id: row.request_id,
		task_id: row.task_id,
		cache_key: row.cache_key,
		payload: JSON.parse(row.payload),
		status: row.status,
		created_at: row.created_at,
		resolved_at: row.resolved_at,
		response: row.response ? JSON.parse(row.response) : null,
	};
}

async function writeEvent(
	stream: { writeSSE(message: { event?: string; data: string; id?: string }): Promise<void> },
	event: ServerEvent,
) {
	await stream.writeSSE({ event: event.type, id: String(event.id), data: JSON.stringify(event) });
}

async function waitForClose(
	signal: AbortSignal,
	off: () => void,
	stream: { writeSSE(message: { event?: string; data: string }): Promise<void> },
): Promise<void> {
	const keepalive = setInterval(() => void stream.writeSSE({ event: "keepalive", data: "{}" }), 15_000);
	try {
		await new Promise<void>((resolve) => {
			if (signal.aborted) {
				resolve();
				return;
			}
			signal.addEventListener("abort", () => resolve(), { once: true });
		});
	} finally {
		clearInterval(keepalive);
		off();
	}
}
