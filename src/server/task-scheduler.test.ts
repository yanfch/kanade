import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/index.ts";
import { HumanGate } from "../human/index.ts";
import { StateStore } from "../store/index.ts";
import { createApp } from "./app.ts";
import { EventBus } from "./event-bus.ts";
import { TaskManager } from "./task-manager.ts";
import { TaskScheduler, nextCronRun } from "./task-scheduler.ts";
import { createMockSessionFactory } from "./test-session-mock.ts";

const WORKFLOW = `export const meta = { name: 'scheduled', description: 'Scheduled workflow' }
return await agent(args.prompt, { label: 'scheduled-agent' })`;

function createTestContext(sessionFactory: ConstructorParameters<typeof TaskManager>[6]) {
	const root = mkdtempSync(join(tmpdir(), "kanade-scheduler-"));
	process.env.KANADE_DIR = root;
	const config = loadConfig();
	config.models.mode = "kanade";
	config.defaults.taskIdPrefix = "SCH";
	const store = new StateStore(config.paths.stateDb);
	const events = new EventBus();
	const humanGate = new HumanGate(store, { initialPollMs: 5 });
	const taskManager = new TaskManager(config, store, events, humanGate, undefined, undefined, sessionFactory);
	return { config, store, events, taskManager, cleanup: () => store.close() };
}

async function waitForTask(taskManager: TaskManager, taskId: string): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < 5_000) {
		const task = taskManager.get(taskId);
		if (task?.status === "finished") return;
		if (task?.status === "failed") throw new Error(task.error ?? "Task failed");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for task ${taskId}`);
}

describe("TaskScheduler", () => {
	it("calculates timezone-aware five-field cron runs", () => {
		const next = nextCronRun("0 9 * * 1-5", "Asia/Shanghai", Date.parse("2026-07-15T00:00:00Z"));
		expect(new Date(next).toISOString()).toBe("2026-07-15T01:00:00.000Z");
	});

	it("runs a fixed saved workflow with prompt, cwd, Pi options, and custom skills", async () => {
		const mock = createMockSessionFactory({ text: "scheduled result" });
		const ctx = createTestContext(mock.createSession);
		const now = Date.parse("2026-07-15T00:00:30Z");
		try {
			ctx.taskManager.putWorkflow("scheduled", WORKFLOW);
			const skillDir = join(ctx.config.paths.root, "custom-skills", "scheduled-skill");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				"---\nname: scheduled-skill\ndescription: Custom scheduled skill\n---\nUse this skill for scheduled tasks.\n",
			);
			const scheduler = new TaskScheduler({
				store: ctx.store,
				taskManager: ctx.taskManager,
				events: ctx.events,
				now: () => now,
			});
			const schedule = scheduler.create({
				name: "daily-review",
				cron: "0 9 * * *",
				timezone: "Asia/Shanghai",
				task: {
					source: "saved",
					workflow_name: "scheduled",
					args: { prompt: "review the repository" },
					options: {
						cwd: ctx.config.paths.root,
						pi: {
							thinking_level: "high",
							tools: ["read", "bash"],
							exclude_tools: ["write"],
							skill_paths: [skillDir],
						},
					},
				},
			});

			const run = await scheduler.runNow(schedule.id);
			expect(run.status).toBe("launched");
			expect(run.task_id).toBeTruthy();
			await waitForTask(ctx.taskManager, run.task_id ?? "");
			const task = ctx.taskManager.get(run.task_id ?? "");
			expect(task?.cwd).toBe(ctx.config.paths.root);
			expect(task?.schedule_run_id).toBe(run.id);
			expect(mock.sessions[0].prompts[0]).toContain("review the repository");
			expect(mock.sessions[0].thinkingLevel).toBe("high");
			expect(mock.sessions[0].allowedTools).toEqual(["read", "bash"]);
			expect(mock.sessions[0].excludedTools).toEqual(["write"]);
			expect(mock.sessions[0].skillNames).toContain("scheduled-skill");
		} finally {
			ctx.cleanup();
		}
	});

	it("claims each due occurrence once", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createTestContext(mock.createSession);
		const now = Date.parse("2026-07-15T00:00:30Z");
		try {
			ctx.taskManager.putWorkflow("scheduled", WORKFLOW);
			const scheduler = new TaskScheduler({
				store: ctx.store,
				taskManager: ctx.taskManager,
				events: ctx.events,
				now: () => now,
			});
			const schedule = scheduler.create({
				name: "once-per-minute",
				cron: "* * * * *",
				timezone: "UTC",
				task: {
					source: "saved",
					workflow_name: "scheduled",
					args: { prompt: "run once" },
				},
			});
			const dueAt = schedule.next_run_at + 1_000;
			expect(await scheduler.runDue(dueAt)).toBe(1);
			expect(await scheduler.runDue(dueAt)).toBe(0);
			const runs = scheduler.listRuns(schedule.id);
			expect(runs).toHaveLength(1);
			expect(runs[0].status).toBe("launched");
			await waitForTask(ctx.taskManager, runs[0].task_id ?? "");
		} finally {
			ctx.cleanup();
		}
	});

	it("skips old missed runs instead of backfilling", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createTestContext(mock.createSession);
		const now = Date.parse("2026-07-15T00:00:30Z");
		try {
			ctx.taskManager.putWorkflow("scheduled", WORKFLOW);
			const scheduler = new TaskScheduler({
				store: ctx.store,
				taskManager: ctx.taskManager,
				events: ctx.events,
				now: () => now,
			});
			const schedule = scheduler.create({
				name: "skip-missed",
				cron: "* * * * *",
				timezone: "UTC",
				task: { source: "saved", workflow_name: "scheduled", args: { prompt: "do not backfill" } },
			});
			await scheduler.runDue(schedule.next_run_at + 2 * 60_000);
			const runs = scheduler.listRuns(schedule.id);
			expect(runs[0].status).toBe("skipped");
			expect(runs[0].reason).toContain("missed");
			expect(mock.sessions).toHaveLength(0);
		} finally {
			ctx.cleanup();
		}
	});

	it("exposes schedule CRUD through the HTTP API", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createTestContext(mock.createSession);
		try {
			ctx.taskManager.putWorkflow("scheduled", WORKFLOW);
			const scheduler = new TaskScheduler({
				store: ctx.store,
				taskManager: ctx.taskManager,
				events: ctx.events,
			});
			const app = createApp({ taskManager: ctx.taskManager, taskScheduler: scheduler, events: ctx.events });
			const created = await app.request("/schedules", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "api-schedule",
					cron: "0 9 * * *",
					timezone: "UTC",
					task: {
						source: "saved",
						workflow_name: "scheduled",
						args: { prompt: "from api" },
					},
				}),
			});
			expect(created.status).toBe(201);
			const body = (await created.json()) as { name: string; task: { args: { prompt: string } } };
			expect(body.name).toBe("api-schedule");
			expect(body.task.args.prompt).toBe("from api");

			const listed = await app.request("/schedules");
			expect(listed.status).toBe(200);
			expect(((await listed.json()) as { schedules: unknown[] }).schedules).toHaveLength(1);
		} finally {
			ctx.cleanup();
		}
	});
});
