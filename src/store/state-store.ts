/**
 * State store: SQLite-backed persistence for tasks, worktrees, agent calls,
 * needs_human queue, phases, and meta.
 *
 * See docs/10-isolation.md for schema rationale.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type TaskStatus = "created" | "running" | "needs_human" | "finished" | "aborted" | "failed";

export interface TaskIterationRow {
	id: string;
	task_id: string;
	parent_task_id: string | null;
	instructions: string | null;
	reuse_branch: string | null;
	created_at: number;
}
export type WorktreeStatus = "creating" | "active" | "inactive" | "merged" | "rejected" | "abandoned";
export type AgentCallStatus = "running" | "completed" | "failed" | "from_cache";
export type NeedsHumanStatus = "pending" | "resolved" | "timeout";
export type WorkflowSource = "saved" | "inline" | "generated";

export interface TaskRow {
	id: string;
	workflow_source: WorkflowSource;
	workflow_name: string | null;
	workflow_path: string;
	status: TaskStatus;
	base_repo: string | null;
	base_branch: string;
	cwd: string;
	created_at: number;
	started_at: number | null;
	finished_at: number | null;
	error: string | null;
	options: string;
	result: string | null;
	usage?: string | null;
	schedule_run_id?: string | null;
}

export interface WorktreeRow {
	id: string;
	task_id: string;
	label: string;
	branch: string;
	base_branch: string;
	worktree_path: string;
	status: WorktreeStatus;
	base_repo: string;
	created_at: number;
	last_used_at: number;
	finished_at: number | null;
	merge_commit: string | null;
}

export interface AgentCallRow {
	id: string;
	task_id: string;
	label: string;
	role: string | null;
	phase: string | null;
	isolation_mode: string;
	worktree_id: string | null;
	status: AgentCallStatus;
	started_at: number;
	finished_at: number | null;
	tokens_input: number | null;
	tokens_output: number | null;
	tokens_cache_read: number | null;
	tokens_cache_creation: number | null;
	cost_usd: number | null;
	trace_id: string | null;
	span_id: string | null;
}

export interface NeedsHumanRow {
	request_id: string;
	task_id: string;
	cache_key: string;
	payload: string;
	status: NeedsHumanStatus;
	created_at: number;
	resolved_at: number | null;
	response: string | null;
}

export interface TaskPhaseRow {
	task_id: string;
	phase: string;
	started_at: number;
	ended_at: number | null;
}

export type ScheduleOverlapPolicy = "skip" | "allow";
export type ScheduleMisfirePolicy = "skip" | "run_once";
export type ScheduleRunStatus = "claimed" | "launched" | "skipped" | "failed";

export interface ScheduleRow {
	id: string;
	name: string;
	cron: string;
	timezone: string;
	task_input: string;
	enabled: number;
	overlap_policy: ScheduleOverlapPolicy;
	misfire_policy: ScheduleMisfirePolicy;
	next_run_at: number;
	created_at: number;
	updated_at: number;
}

export interface ScheduleRunRow {
	id: string;
	schedule_id: string;
	scheduled_for: number;
	status: ScheduleRunStatus;
	task_input: string;
	task_id: string | null;
	reason: string | null;
	created_at: number;
}

const SCHEMA_VERSION = 3;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
	id TEXT PRIMARY KEY,
	workflow_source TEXT NOT NULL,
	workflow_name TEXT,
	workflow_path TEXT NOT NULL,
	status TEXT NOT NULL,
	base_repo TEXT,
	base_branch TEXT NOT NULL DEFAULT 'main',
	cwd TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	started_at INTEGER,
	finished_at INTEGER,
	error TEXT,
	options TEXT NOT NULL,
	result TEXT,
	usage TEXT,
	schedule_run_id TEXT
);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS tasks_created ON tasks(created_at);

CREATE TABLE IF NOT EXISTS worktrees (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL,
	label TEXT NOT NULL,
	branch TEXT NOT NULL,
	base_branch TEXT NOT NULL,
	worktree_path TEXT NOT NULL,
	status TEXT NOT NULL,
	base_repo TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER NOT NULL,
	finished_at INTEGER,
	merge_commit TEXT,
	FOREIGN KEY (task_id) REFERENCES tasks(id)
);
CREATE INDEX IF NOT EXISTS worktrees_task ON worktrees(task_id);
CREATE INDEX IF NOT EXISTS worktrees_status ON worktrees(status);
CREATE INDEX IF NOT EXISTS worktrees_branch ON worktrees(branch);

CREATE TABLE IF NOT EXISTS agent_calls (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL,
	label TEXT NOT NULL,
	role TEXT,
	phase TEXT,
	isolation_mode TEXT NOT NULL,
	worktree_id TEXT,
	status TEXT NOT NULL,
	started_at INTEGER NOT NULL,
	finished_at INTEGER,
	tokens_input INTEGER,
	tokens_output INTEGER,
	tokens_cache_read INTEGER,
	tokens_cache_creation INTEGER,
	cost_usd REAL,
	trace_id TEXT,
	span_id TEXT,
	FOREIGN KEY (task_id) REFERENCES tasks(id),
	FOREIGN KEY (worktree_id) REFERENCES worktrees(id)
);
CREATE INDEX IF NOT EXISTS agent_calls_task ON agent_calls(task_id);

CREATE TABLE IF NOT EXISTS needs_human (
	request_id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL,
	cache_key TEXT NOT NULL,
	payload TEXT NOT NULL,
	status TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	resolved_at INTEGER,
	response TEXT,
	FOREIGN KEY (task_id) REFERENCES tasks(id)
);
CREATE INDEX IF NOT EXISTS needs_human_status ON needs_human(status);
CREATE INDEX IF NOT EXISTS needs_human_task ON needs_human(task_id);

CREATE TABLE IF NOT EXISTS task_phases (
	task_id TEXT NOT NULL,
	phase TEXT NOT NULL,
	started_at INTEGER NOT NULL,
	ended_at INTEGER,
	PRIMARY KEY (task_id, started_at)
);

CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT,
	updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS task_iterations (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL,
	parent_task_id TEXT,
	instructions TEXT,
	reuse_branch TEXT,
	created_at INTEGER NOT NULL,
	FOREIGN KEY (task_id) REFERENCES tasks(id),
	FOREIGN KEY (parent_task_id) REFERENCES tasks(id)
);
CREATE INDEX IF NOT EXISTS iterations_task ON task_iterations(task_id);
CREATE INDEX IF NOT EXISTS iterations_parent ON task_iterations(parent_task_id);

CREATE TABLE IF NOT EXISTS schedules (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	cron TEXT NOT NULL,
	timezone TEXT NOT NULL,
	task_input TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	overlap_policy TEXT NOT NULL DEFAULT 'skip',
	misfire_policy TEXT NOT NULL DEFAULT 'skip',
	next_run_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS schedule_runs (
	id TEXT PRIMARY KEY,
	schedule_id TEXT NOT NULL,
	scheduled_for INTEGER NOT NULL,
	status TEXT NOT NULL,
	task_input TEXT NOT NULL,
	task_id TEXT,
	reason TEXT,
	created_at INTEGER NOT NULL,
	UNIQUE(schedule_id, scheduled_for),
	FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS schedule_runs_schedule ON schedule_runs(schedule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS schedule_runs_status ON schedule_runs(status);
`;

export class StateStore {
	private readonly db: Database.Database;

	constructor(dbPath: string) {
		const dir = dirname(dbPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("foreign_keys = ON");
		this.db.pragma("synchronous = NORMAL");

		this.migrate();
	}

	private migrate(): void {
		this.db.exec(SCHEMA_SQL);

		const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version") as
			| { value: string }
			| undefined;
		const current = row ? Number(row.value) : 0;

		if (current < 2) {
			try {
				this.db.exec("ALTER TABLE tasks ADD COLUMN usage TEXT");
			} catch {
				// Column already exists — idempotent
			}
		}

		if (current < 3) {
			try {
				this.db.exec("ALTER TABLE tasks ADD COLUMN schedule_run_id TEXT");
			} catch {
				// Column already exists — idempotent
			}
			this.db.exec(
				"CREATE UNIQUE INDEX IF NOT EXISTS tasks_schedule_run ON tasks(schedule_run_id) WHERE schedule_run_id IS NOT NULL",
			);
		}

		if (current < SCHEMA_VERSION) {
			this.db
				.prepare("INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES (?, ?, ?)")
				.run("schema_version", String(SCHEMA_VERSION), Date.now());
		}
	}

	close(): void {
		this.db.close();
	}

	// === tasks ===

	insertTask(row: TaskRow): void {
		this.db
			.prepare(
				`INSERT INTO tasks (
					id, workflow_source, workflow_name, workflow_path, status,
					base_repo, base_branch, cwd, created_at, started_at, finished_at,
					error, options, result, schedule_run_id
				) VALUES (
					@id, @workflow_source, @workflow_name, @workflow_path, @status,
					@base_repo, @base_branch, @cwd, @created_at, @started_at, @finished_at,
					@error, @options, @result, @schedule_run_id
				)`,
			)
			.run({ ...row, schedule_run_id: row.schedule_run_id ?? null });
	}

	getTask(id: string): TaskRow | null {
		const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
		return row ?? null;
	}

	getTaskByScheduleRun(scheduleRunId: string): TaskRow | null {
		const row = this.db.prepare("SELECT * FROM tasks WHERE schedule_run_id = ?").get(scheduleRunId) as
			| TaskRow
			| undefined;
		return row ?? null;
	}

	updateTask(id: string, patch: Partial<TaskRow>): void {
		const keys = Object.keys(patch);
		if (keys.length === 0) return;
		const setClause = keys.map((k) => `${k} = @${k}`).join(", ");
		this.db.prepare(`UPDATE tasks SET ${setClause} WHERE id = @__id`).run({ ...patch, __id: id });
	}

	listTasks(opts: { status?: TaskStatus; limit?: number } = {}): TaskRow[] {
		const where = opts.status ? "WHERE status = ?" : "";
		const limit = opts.limit ?? 100;
		const stmt = this.db.prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ${limit}`);
		const rows = opts.status ? stmt.all(opts.status) : stmt.all();
		return rows as TaskRow[];
	}

	/**
	 * List tasks matching any of the given statuses.
	 * Used for startup recovery of orphaned tasks.
	 */
	listTasksByStatuses(statuses: TaskStatus[], limit = 100): TaskRow[] {
		if (statuses.length === 0) return [];
		const placeholders = statuses.map(() => "?").join(", ");
		const rows = this.db
			.prepare(`SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`)
			.all(...statuses, limit);
		return rows as TaskRow[];
	}

	getTaskUsage(taskId: string): Record<string, unknown> | null {
		const row = this.db.prepare("SELECT usage FROM tasks WHERE id = ?").get(taskId) as
			| { usage: string | null }
			| undefined;
		if (!row?.usage) return null;
		try {
			return JSON.parse(row.usage) as Record<string, unknown>;
		} catch {
			return null;
		}
	}

	// === iterations ===

	insertIteration(row: TaskIterationRow): void {
		this.db
			.prepare(
				`INSERT INTO task_iterations (id, task_id, parent_task_id, instructions, reuse_branch, created_at)
				VALUES (@id, @task_id, @parent_task_id, @instructions, @reuse_branch, @created_at)`,
			)
			.run(row);
	}

	getIterationByTask(taskId: string): TaskIterationRow | null {
		const row = this.db.prepare("SELECT * FROM task_iterations WHERE task_id = ?").get(taskId);
		return (row as TaskIterationRow) ?? null;
	}

	getIterationChain(taskId: string): TaskIterationRow[] {
		const chain: TaskIterationRow[] = [];
		let current = taskId;
		while (current) {
			const row = this.db.prepare("SELECT * FROM task_iterations WHERE task_id = ?").get(current) as
				| TaskIterationRow
				| undefined;
			if (row) {
				chain.unshift(row);
				current = row.parent_task_id ?? "";
			} else {
				// Root task (created with create(), not iterate())
				chain.unshift({
					id: `root-${current}`,
					task_id: current,
					parent_task_id: null,
					instructions: null,
					reuse_branch: null,
					created_at: 0,
				});
				break;
			}
		}
		return chain;
	}

	// === worktrees ===

	insertWorktree(row: WorktreeRow): void {
		this.db
			.prepare(
				`INSERT INTO worktrees (
					id, task_id, label, branch, base_branch, worktree_path, status,
					base_repo, created_at, last_used_at, finished_at, merge_commit
				) VALUES (
					@id, @task_id, @label, @branch, @base_branch, @worktree_path, @status,
					@base_repo, @created_at, @last_used_at, @finished_at, @merge_commit
				)`,
			)
			.run(row);
	}

	updateWorktree(id: string, patch: Partial<WorktreeRow>): void {
		const keys = Object.keys(patch);
		if (keys.length === 0) return;
		const setClause = keys.map((k) => `${k} = @${k}`).join(", ");
		this.db.prepare(`UPDATE worktrees SET ${setClause} WHERE id = @__id`).run({ ...patch, __id: id });
	}

	getWorktree(id: string): WorktreeRow | null {
		const row = this.db.prepare("SELECT * FROM worktrees WHERE id = ?").get(id) as WorktreeRow | undefined;
		return row ?? null;
	}

	findWorktreeByBranch(taskId: string, branch: string): WorktreeRow | null {
		const row = this.db.prepare("SELECT * FROM worktrees WHERE task_id = ? AND branch = ?").get(taskId, branch) as
			| WorktreeRow
			| undefined;
		return row ?? null;
	}

	findWorktreesByTask(taskId: string): WorktreeRow[] {
		const rows = this.db.prepare("SELECT * FROM worktrees WHERE task_id = ?").all(taskId);
		return rows as WorktreeRow[];
	}

	findStaleWorktrees(beforeTs: number): WorktreeRow[] {
		const rows = this.db
			.prepare("SELECT * FROM worktrees WHERE status IN ('inactive', 'abandoned') AND last_used_at < ?")
			.all(beforeTs);
		return rows as WorktreeRow[];
	}

	/**
	 * Bulk fetch worktrees for a set of task ids.
	 * Returns a Map keyed by task_id to avoid N+1 queries in list paths.
	 */
	findWorktreesByTaskIds(taskIds: string[]): Map<string, WorktreeRow[]> {
		const result = new Map<string, WorktreeRow[]>();
		if (taskIds.length === 0) return result;
		const placeholders = taskIds.map(() => "?").join(", ");
		const rows = this.db
			.prepare(`SELECT * FROM worktrees WHERE task_id IN (${placeholders}) ORDER BY last_used_at DESC`)
			.all(...taskIds) as WorktreeRow[];
		for (const row of rows) {
			let list = result.get(row.task_id);
			if (!list) {
				list = [];
				result.set(row.task_id, list);
			}
			list.push(row);
		}
		return result;
	}

	listActiveWorktrees(): WorktreeRow[] {
		const rows = this.db
			.prepare("SELECT * FROM worktrees WHERE status IN ('active', 'inactive') ORDER BY last_used_at DESC")
			.all();
		return rows as WorktreeRow[];
	}

	// === agent_calls ===

	insertAgentCall(row: AgentCallRow): void {
		this.db
			.prepare(
				`INSERT INTO agent_calls (
					id, task_id, label, role, phase, isolation_mode, worktree_id, status,
					started_at, finished_at, tokens_input, tokens_output,
					tokens_cache_read, tokens_cache_creation, cost_usd, trace_id, span_id
				) VALUES (
					@id, @task_id, @label, @role, @phase, @isolation_mode, @worktree_id, @status,
					@started_at, @finished_at, @tokens_input, @tokens_output,
					@tokens_cache_read, @tokens_cache_creation, @cost_usd, @trace_id, @span_id
				)`,
			)
			.run(row);
	}

	updateAgentCall(id: string, patch: Partial<AgentCallRow>): void {
		const keys = Object.keys(patch);
		if (keys.length === 0) return;
		const setClause = keys.map((k) => `${k} = @${k}`).join(", ");
		this.db.prepare(`UPDATE agent_calls SET ${setClause} WHERE id = @__id`).run({ ...patch, __id: id });
	}

	listAgentCalls(taskId: string): AgentCallRow[] {
		const rows = this.db.prepare("SELECT * FROM agent_calls WHERE task_id = ? ORDER BY started_at ASC").all(taskId);
		return rows as AgentCallRow[];
	}

	// === needs_human ===

	insertNeedsHuman(row: NeedsHumanRow): void {
		this.db
			.prepare(
				`INSERT INTO needs_human (
					request_id, task_id, cache_key, payload, status,
					created_at, resolved_at, response
				) VALUES (
					@request_id, @task_id, @cache_key, @payload, @status,
					@created_at, @resolved_at, @response
				)`,
			)
			.run(row);
	}

	getNeedsHuman(requestId: string): NeedsHumanRow | null {
		const row = this.db.prepare("SELECT * FROM needs_human WHERE request_id = ?").get(requestId) as
			| NeedsHumanRow
			| undefined;
		return row ?? null;
	}

	findNeedsHumanByCacheKey(taskId: string, cacheKey: string): NeedsHumanRow | null {
		const row = this.db
			.prepare("SELECT * FROM needs_human WHERE task_id = ? AND cache_key = ? ORDER BY created_at DESC LIMIT 1")
			.get(taskId, cacheKey) as NeedsHumanRow | undefined;
		return row ?? null;
	}

	updateNeedsHuman(requestId: string, patch: Partial<NeedsHumanRow>): void {
		const keys = Object.keys(patch);
		if (keys.length === 0) return;
		const setClause = keys.map((k) => `${k} = @${k}`).join(", ");
		this.db.prepare(`UPDATE needs_human SET ${setClause} WHERE request_id = @__id`).run({ ...patch, __id: requestId });
	}

	listPendingNeedsHuman(): NeedsHumanRow[] {
		const rows = this.db.prepare("SELECT * FROM needs_human WHERE status = 'pending' ORDER BY created_at ASC").all();
		return rows as NeedsHumanRow[];
	}

	listNeedsHumanByTask(taskId: string): NeedsHumanRow[] {
		const rows = this.db.prepare("SELECT * FROM needs_human WHERE task_id = ? ORDER BY created_at ASC").all(taskId);
		return rows as NeedsHumanRow[];
	}

	// === task_phases ===

	insertPhase(row: TaskPhaseRow): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO task_phases (task_id, phase, started_at, ended_at)
				 VALUES (@task_id, @phase, @started_at, @ended_at)`,
			)
			.run(row);
	}

	endCurrentPhase(taskId: string, endedAt: number): void {
		this.db
			.prepare(
				`UPDATE task_phases SET ended_at = ?
				 WHERE task_id = ? AND ended_at IS NULL`,
			)
			.run(endedAt, taskId);
	}

	listPhases(taskId: string): TaskPhaseRow[] {
		const rows = this.db.prepare("SELECT * FROM task_phases WHERE task_id = ? ORDER BY started_at ASC").all(taskId);
		return rows as TaskPhaseRow[];
	}

	// === schedules ===

	insertSchedule(row: ScheduleRow): void {
		this.db
			.prepare(
				`INSERT INTO schedules (
					id, name, cron, timezone, task_input, enabled, overlap_policy,
					misfire_policy, next_run_at, created_at, updated_at
				) VALUES (
					@id, @name, @cron, @timezone, @task_input, @enabled, @overlap_policy,
					@misfire_policy, @next_run_at, @created_at, @updated_at
				)`,
			)
			.run(row);
	}

	getSchedule(idOrName: string): ScheduleRow | null {
		const row = this.db.prepare("SELECT * FROM schedules WHERE id = ? OR name = ?").get(idOrName, idOrName) as
			| ScheduleRow
			| undefined;
		return row ?? null;
	}

	listSchedules(): ScheduleRow[] {
		return this.db.prepare("SELECT * FROM schedules ORDER BY name ASC").all() as ScheduleRow[];
	}

	listDueSchedules(now: number): ScheduleRow[] {
		return this.db
			.prepare("SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC")
			.all(now) as ScheduleRow[];
	}

	updateSchedule(id: string, patch: Partial<ScheduleRow>): void {
		const keys = Object.keys(patch);
		if (keys.length === 0) return;
		const setClause = keys.map((key) => `${key} = @${key}`).join(", ");
		this.db.prepare(`UPDATE schedules SET ${setClause} WHERE id = @__id`).run({ ...patch, __id: id });
	}

	deleteSchedule(id: string): boolean {
		return this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes > 0;
	}

	claimDueSchedule(run: ScheduleRunRow, expectedNextRunAt: number, nextRunAt: number): boolean {
		const claim = this.db.transaction(() => {
			const updated = this.db
				.prepare(
					"UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ? AND enabled = 1 AND next_run_at = ?",
				)
				.run(nextRunAt, Date.now(), run.schedule_id, expectedNextRunAt);
			if (updated.changes === 0) return false;
			this.insertScheduleRun(run);
			return true;
		});
		try {
			return claim();
		} catch (error) {
			if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) return false;
			throw error;
		}
	}

	insertScheduleRun(row: ScheduleRunRow): void {
		this.db
			.prepare(
				`INSERT INTO schedule_runs (
					id, schedule_id, scheduled_for, status, task_input, task_id, reason, created_at
				) VALUES (
					@id, @schedule_id, @scheduled_for, @status, @task_input, @task_id, @reason, @created_at
				)`,
			)
			.run(row);
	}

	updateScheduleRun(id: string, patch: Partial<ScheduleRunRow>): void {
		const keys = Object.keys(patch);
		if (keys.length === 0) return;
		const setClause = keys.map((key) => `${key} = @${key}`).join(", ");
		this.db.prepare(`UPDATE schedule_runs SET ${setClause} WHERE id = @__id`).run({ ...patch, __id: id });
	}

	listScheduleRuns(scheduleId: string, limit = 100): ScheduleRunRow[] {
		return this.db
			.prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY created_at DESC LIMIT ?")
			.all(scheduleId, limit) as ScheduleRunRow[];
	}

	listClaimedScheduleRuns(): ScheduleRunRow[] {
		return this.db
			.prepare("SELECT * FROM schedule_runs WHERE status = 'claimed' ORDER BY created_at ASC")
			.all() as ScheduleRunRow[];
	}

	hasActiveTaskForSchedule(scheduleId: string): boolean {
		const row = this.db
			.prepare(
				`SELECT 1
				 FROM schedule_runs sr
				 JOIN tasks t ON t.schedule_run_id = sr.id
				 WHERE sr.schedule_id = ? AND t.status IN ('created', 'running', 'needs_human')
				 LIMIT 1`,
			)
			.get(scheduleId);
		return Boolean(row);
	}
}
