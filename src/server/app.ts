import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
	type KanadeConfig,
	maskConfig,
	validateConfigPatch,
	writeConfigPatch,
	writeConfigReplace,
} from "../config/config.ts";
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
		const agentCalls = ctx.taskManager.getAgentCalls(taskId);
		const { usage: _rawUsage, ...taskBody } = task;
		return c.json({ task: taskBody, usage, agent_calls: agentCalls });
	});

	app.get("/inbox", (c) => c.json({ requests: ctx.taskManager.inbox().map(formatInboxRow) }));

	app.get("/recovery", (c) => {
		const state = parseRecoveryState(c.req.query("state"));
		const actionable = parseBooleanQuery(c.req.query("actionable"));
		return c.json({ tasks: ctx.taskManager.listRecovery({ state, actionable }) });
	});

	app.post("/recovery/cleanup", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as {
			task_id?: unknown;
			taskId?: unknown;
			older_than_ms?: unknown;
			olderThanMs?: unknown;
			execute?: unknown;
			confirmed?: unknown;
		};
		const taskId = typeof body.task_id === "string" ? body.task_id : body.taskId;
		const olderThanMs = typeof body.older_than_ms === "number" ? body.older_than_ms : body.olderThanMs;
		const result = await ctx.taskManager.cleanupRecovery({
			taskId: typeof taskId === "string" ? taskId : undefined,
			olderThanMs: typeof olderThanMs === "number" ? olderThanMs : undefined,
			execute: body.execute === true,
			confirmed: body.confirmed === true,
		});
		return c.json(result);
	});

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

	app.get("/tasks/:id/graph", (c) => {
		const snapshot = ctx.taskManager.getSnapshot(c.req.param("id"));
		if (!snapshot) return c.json({ error: "Not found" }, 404);
		return c.json({ graph: snapshot.graph });
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

	app.post("/tasks/:id/reconcile", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { merge_commit?: unknown; mergeCommit?: unknown };
		const mergeCommit = typeof body.merge_commit === "string" ? body.merge_commit : body.mergeCommit;
		const result = ctx.taskManager.reconcileMerged(c.req.param("id"), {
			mergeCommit: typeof mergeCommit === "string" ? mergeCommit : undefined,
		});
		if (!result.success) return c.json({ error: result.error, result }, 400);
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

	// ── Review / merge-readiness ─────────────────────────────────────────────

	app.get("/tasks/:id/review", (c) => {
		const review = ctx.taskManager.getReview(c.req.param("id"));
		if (!review) return c.json({ error: "Task not found" }, 404);
		return c.json(review);
	});

	// ── Config API ──────────────────────────────────────────────────────────

	app.get("/config", (c) => {
		if (!ctx.config) return c.json({ error: "Config not available" }, 500);
		return c.json(maskConfig(ctx.config));
	});

	app.patch("/config", async (c) => {
		if (!ctx.config) return c.json({ error: "Config not available" }, 500);
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const validation = validateConfigPatch(body);
		if (!validation.valid) {
			return c.json({ error: "Validation failed", errors: validation.errors }, 400);
		}
		try {
			const newConfig = writeConfigPatch(ctx.config, validation.sanitized);
			ctx.config = newConfig;
			ctx.taskManager.updateConfig(newConfig);
			return c.json({ ok: true, config: maskConfig(newConfig), requires_restart: validation.requiresRestart });
		} catch (err) {
			return c.json({ error: `Failed to write config: ${err instanceof Error ? err.message : String(err)}` }, 500);
		}
	});

	app.put("/config", async (c) => {
		if (!ctx.config) return c.json({ error: "Config not available" }, 500);
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const validation = validateConfigPatch(body);
		if (!validation.valid) {
			return c.json({ error: "Validation failed", errors: validation.errors }, 400);
		}
		try {
			const newConfig = writeConfigReplace(ctx.config, validation.sanitized);
			ctx.config = newConfig;
			ctx.taskManager.updateConfig(newConfig);
			return c.json({ ok: true, config: maskConfig(newConfig), requires_restart: validation.requiresRestart });
		} catch (err) {
			return c.json({ error: `Failed to write config: ${err instanceof Error ? err.message : String(err)}` }, 500);
		}
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
			return {
				label,
				files,
				paths: files.map((file) => join(labelDir, file)),
			};
		});
		return c.json({ sessions });
	});

	app.get("/tasks/:id/sessions/:label", (c) => {
		const taskId = c.req.param("id");
		const label = c.req.param("label");
		if (!ctx.taskManager.get(taskId)) return c.json({ error: "Task not found" }, 404);
		const config = ctx.config;
		if (!config) return c.json({ error: "Config not available" }, 500);
		const session = resolveSessionFile(config, taskId, label);
		if (!session) return c.json({ error: "Session not found" }, 404);
		const content = readFileSync(session.path, "utf8");
		const entries = parseSessionLines(content);
		return c.json({ label, entries, file: session.file, path: session.path });
	});

	app.get("/tasks/:id/sessions/:label/stream", (c) => {
		const taskId = c.req.param("id");
		const label = c.req.param("label");
		if (!ctx.taskManager.get(taskId)) return c.json({ error: "Task not found" }, 404);
		const config = ctx.config;
		if (!config) return c.json({ error: "Config not available" }, 500);
		const session = resolveSessionFile(config, taskId, label);
		if (!session) return c.json({ error: "Session not found" }, 404);
		return streamSSE(c, async (stream) => {
			let offset = 0;
			let eventId = 0;
			let carry = "";
			const writeNewEntries = async () => {
				const stat = statSync(session.path);
				if (stat.size <= offset) return;
				const chunk = carry + readFileSync(session.path).subarray(offset, stat.size).toString("utf8");
				offset = stat.size;
				const lines = chunk.split("\n");
				carry = lines.pop() ?? "";
				for (const entry of parseSessionLines(lines.join("\n"))) {
					eventId++;
					await stream.writeSSE({
						event: "session.entry",
						id: String(eventId),
						data: JSON.stringify({ taskId, label, path: session.path, entry }),
					});
				}
			};
			await writeNewEntries();
			const timer = setInterval(() => void writeNewEntries().catch(() => {}), 1000);
			await waitForClose(c.req.raw.signal, () => clearInterval(timer), stream);
		});
	});

	return app;
}

function parseBooleanQuery(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	return value === "1" || value === "true" || value === "yes";
}

function parseRecoveryState(
	value: string | undefined,
): "preserved" | "merged" | "rejected" | "no_worktree" | undefined {
	if (value === "preserved" || value === "merged" || value === "rejected" || value === "no_worktree") return value;
	return undefined;
}

function resolveSessionFile(
	config: KanadeConfig,
	taskId: string,
	label: string,
): { file: string; path: string } | null {
	const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_");
	const labelDir = join(config.paths.runsDir, taskId, "debug", "subagents", safeLabel);
	if (!existsSync(labelDir)) return null;
	const files = readdirSync(labelDir).filter((f) => f.endsWith(".jsonl"));
	if (!files.length) return null;
	const file = files[files.length - 1];
	return { file, path: join(labelDir, file) };
}

function parseSessionLines(content: string): unknown[] {
	return content
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line) as unknown;
			} catch {
				return null;
			}
		})
		.filter(Boolean);
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
