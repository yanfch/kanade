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

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
	id TEXT PRIMARY KEY,
	workflow_source TEXT NOT NULL,
	workflow_name TEXT,
	workflow_path TEXT NOT NULL,
	status TEXT NOT NULL,
	base_repo TEXT,
	base_branch TEXT NOT NULL DEFAULT 'develop',
	cwd TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	started_at INTEGER,
	finished_at INTEGER,
	error TEXT,
	options TEXT NOT NULL,
	result TEXT
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
					error, options, result
				) VALUES (
					@id, @workflow_source, @workflow_name, @workflow_path, @status,
					@base_repo, @base_branch, @cwd, @created_at, @started_at, @finished_at,
					@error, @options, @result
				)`,
			)
			.run(row);
	}

	getTask(id: string): TaskRow | null {
		const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
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
}
