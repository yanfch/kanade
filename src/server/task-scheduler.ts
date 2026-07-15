import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import type {
	ScheduleMisfirePolicy,
	ScheduleOverlapPolicy,
	ScheduleRow,
	ScheduleRunRow,
	StateStore,
} from "../store/index.ts";
import { AppError } from "./errors.ts";
import type { EventBus } from "./event-bus.ts";
import type { CreateTaskInput, PiRuntimeOptions, TaskManager } from "./task-manager.ts";

const MISFIRE_GRACE_MS = 60_000;

export type ScheduledTaskInput = Extract<CreateTaskInput, { source: "saved" }>;

export interface Schedule {
	id: string;
	name: string;
	cron: string;
	timezone: string;
	task: ScheduledTaskInput;
	enabled: boolean;
	overlap_policy: ScheduleOverlapPolicy;
	misfire_policy: ScheduleMisfirePolicy;
	next_run_at: number;
	created_at: number;
	updated_at: number;
}

export interface CreateScheduleInput {
	name: string;
	cron: string;
	timezone?: string;
	task: ScheduledTaskInput;
	enabled?: boolean;
	overlap_policy?: ScheduleOverlapPolicy;
	misfire_policy?: ScheduleMisfirePolicy;
}

export interface UpdateScheduleInput {
	name?: string;
	cron?: string;
	timezone?: string;
	task?: ScheduledTaskInput;
	enabled?: boolean;
	overlap_policy?: ScheduleOverlapPolicy;
	misfire_policy?: ScheduleMisfirePolicy;
}

interface SchedulerLogger {
	info(message: string, attributes?: Record<string, string>): void;
	warn(message: string, attributes?: Record<string, string>): void;
	error(message: string, error?: unknown): void;
}

export interface TaskSchedulerOptions {
	store: StateStore;
	taskManager: TaskManager;
	events: EventBus;
	logger?: SchedulerLogger;
	pollMs?: number;
	now?: () => number;
}

export function nextCronRun(cron: string, timezone: string, afterMs: number): number {
	const fields = cron.trim().split(/\s+/);
	if (fields.length !== 5) throw new AppError("cron must contain exactly 5 fields", 400);
	assertTimezone(timezone);
	try {
		return CronExpressionParser.parse(`0 ${cron}`, {
			currentDate: new Date(afterMs),
			tz: timezone,
			strict: true,
		})
			.next()
			.getTime();
	} catch (error) {
		throw new AppError(`Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`, 400);
	}
}

export class TaskScheduler {
	private readonly logger: SchedulerLogger;
	private readonly pollMs: number;
	private readonly now: () => number;
	private intervalId: ReturnType<typeof setInterval> | null = null;
	private ticking = false;

	constructor(private readonly options: TaskSchedulerOptions) {
		this.logger = options.logger ?? {
			info() {},
			warn() {},
			error() {},
		};
		this.pollMs = options.pollMs ?? 5_000;
		this.now = options.now ?? Date.now;
	}

	start(): void {
		if (this.intervalId) return;
		this.logger.info("task scheduler started", { pollMs: String(this.pollMs) });
		void this.tick();
		this.intervalId = setInterval(() => void this.tick(), this.pollMs);
	}

	stop(): void {
		if (!this.intervalId) return;
		clearInterval(this.intervalId);
		this.intervalId = null;
	}

	create(input: CreateScheduleInput): Schedule {
		const now = this.now();
		const name = requireNonEmpty(input.name, "name");
		const timezone = input.timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
		const cron = requireNonEmpty(input.cron, "cron");
		this.validateTask(input.task);
		const row: ScheduleRow = {
			id: `S-${randomUUID()}`,
			name,
			cron,
			timezone,
			task_input: JSON.stringify(input.task),
			enabled: input.enabled === false ? 0 : 1,
			overlap_policy: validateOverlapPolicy(input.overlap_policy),
			misfire_policy: validateMisfirePolicy(input.misfire_policy),
			next_run_at: nextCronRun(cron, timezone, now),
			created_at: now,
			updated_at: now,
		};
		try {
			this.options.store.insertSchedule(row);
		} catch (error) {
			if (error instanceof Error && error.message.includes("UNIQUE constraint failed: schedules.name")) {
				throw new AppError(`Schedule already exists: ${name}`, 409);
			}
			throw error;
		}
		return deserializeSchedule(row);
	}

	update(idOrName: string, input: UpdateScheduleInput): Schedule {
		const current = this.requireSchedule(idOrName);
		const now = this.now();
		const cron = input.cron === undefined ? current.cron : requireNonEmpty(input.cron, "cron");
		const timezone = input.timezone === undefined ? current.timezone : requireNonEmpty(input.timezone, "timezone");
		const task = input.task ?? parseTaskInput(current.task_input);
		this.validateTask(task);
		const enabled = input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0;
		const scheduleChanged =
			input.cron !== undefined || input.timezone !== undefined || (current.enabled === 0 && enabled === 1);
		const patch: Partial<ScheduleRow> = {
			name: input.name === undefined ? current.name : requireNonEmpty(input.name, "name"),
			cron,
			timezone,
			task_input: JSON.stringify(task),
			enabled,
			overlap_policy:
				input.overlap_policy === undefined ? current.overlap_policy : validateOverlapPolicy(input.overlap_policy),
			misfire_policy:
				input.misfire_policy === undefined ? current.misfire_policy : validateMisfirePolicy(input.misfire_policy),
			next_run_at: scheduleChanged ? nextCronRun(cron, timezone, now) : current.next_run_at,
			updated_at: now,
		};
		try {
			this.options.store.updateSchedule(current.id, patch);
		} catch (error) {
			if (error instanceof Error && error.message.includes("UNIQUE constraint failed: schedules.name")) {
				throw new AppError(`Schedule already exists: ${patch.name}`, 409);
			}
			throw error;
		}
		return deserializeSchedule({ ...current, ...patch });
	}

	get(idOrName: string): Schedule | null {
		const row = this.options.store.getSchedule(idOrName);
		return row ? deserializeSchedule(row) : null;
	}

	list(): Schedule[] {
		return this.options.store.listSchedules().map(deserializeSchedule);
	}

	listRuns(idOrName: string, limit = 100): ScheduleRunRow[] {
		return this.options.store.listScheduleRuns(this.requireSchedule(idOrName).id, limit);
	}

	delete(idOrName: string): void {
		const schedule = this.requireSchedule(idOrName);
		this.options.store.deleteSchedule(schedule.id);
	}

	async runNow(idOrName: string): Promise<ScheduleRunRow> {
		const schedule = this.requireSchedule(idOrName);
		const now = this.now();
		const run = this.buildRun(schedule, now, "claimed", null, now);
		this.options.store.insertScheduleRun(run);
		return this.dispatchClaimedRun(run, schedule);
	}

	async runDue(now = this.now()): Promise<number> {
		let handled = 0;
		for (const schedule of this.options.store.listDueSchedules(now)) {
			const nextRunAt = nextCronRun(schedule.cron, schedule.timezone, now);
			let status: ScheduleRunRow["status"] = "claimed";
			let reason: string | null = null;
			if (now - schedule.next_run_at > MISFIRE_GRACE_MS && schedule.misfire_policy === "skip") {
				status = "skipped";
				reason = "missed while scheduler was not running";
			} else if (schedule.overlap_policy === "skip" && this.options.store.hasActiveTaskForSchedule(schedule.id)) {
				status = "skipped";
				reason = "previous task is still active";
			} else if (!this.options.taskManager.canStartTask()) {
				status = "skipped";
				reason = "task concurrency limit reached";
			}

			const run = this.buildRun(schedule, schedule.next_run_at, status, reason, now);
			if (!this.options.store.claimDueSchedule(run, schedule.next_run_at, nextRunAt)) continue;
			handled++;
			if (status === "claimed") await this.dispatchClaimedRun(run, schedule);
			else this.emitSkipped(schedule, run);
		}
		return handled;
	}

	async recoverClaimedRuns(): Promise<number> {
		let recovered = 0;
		for (const run of this.options.store.listClaimedScheduleRuns()) {
			const schedule = this.options.store.getSchedule(run.schedule_id);
			if (!schedule) continue;
			await this.dispatchClaimedRun(run, schedule);
			recovered++;
		}
		return recovered;
	}

	private async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			await this.recoverClaimedRuns();
			await this.runDue();
		} catch (error) {
			this.logger.error("task scheduler tick failed", error);
		} finally {
			this.ticking = false;
		}
	}

	private async dispatchClaimedRun(run: ScheduleRunRow, schedule: ScheduleRow): Promise<ScheduleRunRow> {
		try {
			const task = parseTaskInput(run.task_input);
			const result = this.options.taskManager.createScheduled(task, run.id);
			const launched = { ...run, status: "launched" as const, task_id: result.task_id, reason: null };
			this.options.store.updateScheduleRun(run.id, {
				status: launched.status,
				task_id: launched.task_id,
				reason: null,
			});
			this.options.events.emit("schedule.triggered", {
				scheduleId: schedule.id,
				scheduleName: schedule.name,
				runId: run.id,
				taskId: result.task_id,
				scheduledFor: run.scheduled_for,
			});
			return launched;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			const failed = { ...run, status: "failed" as const, reason };
			this.options.store.updateScheduleRun(run.id, { status: failed.status, reason });
			this.options.events.emit("schedule.failed", {
				scheduleId: schedule.id,
				scheduleName: schedule.name,
				runId: run.id,
				reason,
			});
			this.logger.warn("scheduled task launch failed", { scheduleId: schedule.id, reason });
			return failed;
		}
	}

	private emitSkipped(schedule: ScheduleRow, run: ScheduleRunRow): void {
		this.options.events.emit("schedule.skipped", {
			scheduleId: schedule.id,
			scheduleName: schedule.name,
			runId: run.id,
			reason: run.reason,
			scheduledFor: run.scheduled_for,
		});
	}

	private buildRun(
		schedule: ScheduleRow,
		scheduledFor: number,
		status: ScheduleRunRow["status"],
		reason: string | null,
		createdAt: number,
	): ScheduleRunRow {
		return {
			id: `SR-${randomUUID()}`,
			schedule_id: schedule.id,
			scheduled_for: scheduledFor,
			status,
			task_input: schedule.task_input,
			task_id: null,
			reason,
			created_at: createdAt,
		};
	}

	private requireSchedule(idOrName: string): ScheduleRow {
		const schedule = this.options.store.getSchedule(idOrName);
		if (!schedule) throw new AppError(`Schedule not found: ${idOrName}`, 404);
		return schedule;
	}

	private validateTask(task: ScheduledTaskInput): void {
		if (!task || task.source !== "saved") throw new AppError("scheduled task source must be saved", 400);
		if (!task.workflow_name?.trim()) throw new AppError("task.workflow_name is required", 400);
		if (!this.options.taskManager.getWorkflow(task.workflow_name)) {
			throw new AppError(`Workflow not found: ${task.workflow_name}`, 404);
		}
		validatePiOptions(task.options?.pi);
	}
}

function deserializeSchedule(row: ScheduleRow): Schedule {
	return {
		id: row.id,
		name: row.name,
		cron: row.cron,
		timezone: row.timezone,
		task: parseTaskInput(row.task_input),
		enabled: row.enabled === 1,
		overlap_policy: row.overlap_policy,
		misfire_policy: row.misfire_policy,
		next_run_at: row.next_run_at,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

function parseTaskInput(value: string): ScheduledTaskInput {
	return JSON.parse(value) as ScheduledTaskInput;
}

function requireNonEmpty(value: string, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new AppError(`${field} is required`, 400);
	return value.trim();
}

function validateOverlapPolicy(value: unknown): ScheduleOverlapPolicy {
	if (value === undefined || value === "skip") return "skip";
	if (value === "allow") return value;
	throw new AppError("overlap_policy must be skip or allow", 400);
}

function validateMisfirePolicy(value: unknown): ScheduleMisfirePolicy {
	if (value === undefined || value === "skip") return "skip";
	if (value === "run_once") return value;
	throw new AppError("misfire_policy must be skip or run_once", 400);
}

function assertTimezone(timezone: string): void {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
	} catch {
		throw new AppError(`Invalid timezone: ${timezone}`, 400);
	}
}

function validatePiOptions(pi: PiRuntimeOptions | undefined): void {
	if (!pi) return;
	const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
	if (pi.thinking_level !== undefined && !thinkingLevels.has(pi.thinking_level)) {
		throw new AppError("pi.thinking_level is invalid", 400);
	}
	if (pi.no_tools !== undefined && pi.no_tools !== "all" && pi.no_tools !== "builtin") {
		throw new AppError("pi.no_tools must be all or builtin", 400);
	}
	for (const [name, values] of [
		["tools", pi.tools],
		["exclude_tools", pi.exclude_tools],
		["skill_paths", pi.skill_paths],
	] as const) {
		if (values !== undefined && (!Array.isArray(values) || values.some((value) => typeof value !== "string"))) {
			throw new AppError(`pi.${name} must be an array of strings`, 400);
		}
	}
}
