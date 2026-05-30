import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SpanStatusCode, type Tracer } from "@opentelemetry/api";
import type { KanadeConfig } from "../config/index.ts";
import type { HumanGate } from "../human/index.ts";
import { IsolationManager } from "../isolation/index.ts";
import { Journal, type JournalAllEntries } from "../journal/index.ts";
import type { NeedsHumanRow, StateStore, TaskRow, TaskStatus, WorkflowSource } from "../store/index.ts";
import * as Attrs from "../tracing/attributes.ts";
import type { TracingHandle, Logger as TracingLogger } from "../tracing/index.ts";
import { runWorkflow } from "../workflow-engine/index.ts";
import { AppError } from "./errors.ts";
import type { EventBus } from "./event-bus.ts";
import { LlmWorkflowAuthor, StubWorkflowAuthor, type WorkflowAuthor } from "./workflow-author.ts";
import { type WorkflowInfo, WorkflowStore } from "./workflow-store.ts";

export interface TaskOptions {
	cwd?: string;
	model?: string;
	concurrency?: number;
	token_budget?: number;
}

export type CreateTaskInput =
	| { source: "inline"; script: string; args?: unknown; options?: TaskOptions }
	| { source: "saved"; workflow_name: string; args?: unknown; options?: TaskOptions }
	| { source: "generated"; prompt: string; args?: unknown; options?: TaskOptions };

export interface CreateTaskResult {
	task_id: string;
	run_dir: string;
	workflow_path: string;
	rerun_of?: string;
	generated?: true;
}

export class TaskManager {
	private nextTaskSeq = 1;
	private readonly controllers = new Map<string, AbortController>();
	private readonly workflowStore: WorkflowStore;
	private readonly author: WorkflowAuthor;
	private readonly isolation: IsolationManager;

	private readonly logger: TracingLogger;
	private readonly tracer: Tracer;

	constructor(
		private readonly config: KanadeConfig,
		private readonly store: StateStore,
		private readonly events: EventBus,
		private readonly humanGate: HumanGate,
		author?: WorkflowAuthor,
		tracing?: TracingHandle,
	) {
		this.workflowStore = new WorkflowStore(config.paths.workflowsDir);
		this.author = author ?? this.resolveAuthor();
		this.isolation = new IsolationManager(
			store,
			{
				defaultBaseBranch: config.isolation.defaultBaseBranch,
				branchPrefix: config.isolation.branchPrefix,
				autoCleanupOnReject: config.isolation.autoCleanupOnReject,
				autoCleanupOnApprove: config.isolation.autoCleanupOnApprove,
				autoCleanupOnAbort: config.isolation.autoCleanupOnAbort,
			},
			config.merge,
		);
		this.logger = tracing?.logger.forComponent("task-manager") ?? createNoopLogger();
		this.tracer = tracing?.tracer ?? ({ startSpan: () => noopSpan } as unknown as Tracer);
	}

	create(input: CreateTaskInput): CreateTaskResult {
		if (input.source === "saved") {
			const workflow = this.workflowStore.get(input.workflow_name);
			if (!workflow) throw new AppError(`Workflow not found: ${input.workflow_name}`, 404);
			return this.createFromScript("saved", input.workflow_name, workflow.script, input.args, input.options);
		}
		if (input.source === "generated") {
			return this.createGenerated(input.prompt, input.args, input.options);
		}
		if (!input.script?.trim()) throw new Error("script is required");
		return this.createFromScript("inline", null, input.script, input.args, input.options);
	}

	private createGenerated(prompt: string, args: unknown, options: TaskOptions | undefined): CreateTaskResult {
		const taskId = this.allocateTaskId();
		const runDir = join(this.config.paths.runsDir, taskId);
		mkdirSync(runDir, { recursive: true });
		const workflowPath = join(runDir, "workflow.js");

		const now = Date.now();
		this.store.insertTask({
			id: taskId,
			workflow_source: "generated",
			workflow_name: null,
			workflow_path: workflowPath,
			status: "created",
			base_repo: null,
			base_branch: this.config.isolation.defaultBaseBranch,
			cwd: options?.cwd ?? process.cwd(),
			created_at: now,
			started_at: null,
			finished_at: null,
			error: null,
			options: JSON.stringify(options ?? {}),
			result: null,
		});

		this.events.emit("task.created", { taskId, runDir, workflowPath }, taskId);
		void this.runGenerated(taskId, workflowPath, prompt, args, options).catch(() => undefined);
		return { task_id: taskId, run_dir: runDir, workflow_path: workflowPath, generated: true };
	}

	private async runGenerated(
		taskId: string,
		workflowPath: string,
		prompt: string,
		args: unknown,
		options: TaskOptions | undefined,
	): Promise<void> {
		try {
			const script = await this.author.generate(prompt);
			writeFileSync(workflowPath, script, "utf8");
			this.events.emit("task.script_generated", { taskId, workflowPath }, taskId);
			await this.run(taskId, script, args, options);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			this.store.updateTask(taskId, { status: "failed", finished_at: Date.now(), error: msg });
			this.events.emit("task.failed", { taskId, error: msg }, taskId);
		}
	}

	private createFromScript(
		source: WorkflowSource,
		workflowName: string | null,
		script: string,
		args: unknown,
		options: TaskOptions | undefined,
	): CreateTaskResult {
		const taskId = this.allocateTaskId();
		const runDir = join(this.config.paths.runsDir, taskId);
		mkdirSync(runDir, { recursive: true });
		const workflowPath = join(runDir, "workflow.js");
		writeFileSync(workflowPath, script, "utf8");

		const now = Date.now();
		this.store.insertTask({
			id: taskId,
			workflow_source: source,
			workflow_name: workflowName,
			workflow_path: workflowPath,
			status: "created",
			base_repo: null,
			base_branch: this.config.isolation.defaultBaseBranch,
			cwd: options?.cwd ?? process.cwd(),
			created_at: now,
			started_at: null,
			finished_at: null,
			error: null,
			options: JSON.stringify(options ?? {}),
			result: null,
		});

		this.events.emit("task.created", { taskId, runDir, workflowPath }, taskId);
		void this.run(taskId, script, args, options).catch(() => undefined);
		return { task_id: taskId, run_dir: runDir, workflow_path: workflowPath };
	}

	get(taskId: string): TaskRow | null {
		return this.store.getTask(taskId);
	}

	list(status?: TaskStatus): TaskRow[] {
		return this.store.listTasks({ status });
	}

	inbox(): NeedsHumanRow[] {
		return this.store.listPendingNeedsHuman();
	}

	respond(taskId: string, requestId: string, response: unknown): void {
		const row = this.store.getNeedsHuman(requestId);
		if (!row || row.task_id !== taskId) throw new Error(`Human request not found for task: ${requestId}`);
		this.humanGate.resolve(requestId, response as never);
		this.store.updateTask(taskId, { status: "running" });
		this.events.emit("task.human_resolved", { taskId, requestId, response }, taskId);
	}

	getJournal(taskId: string): JournalAllEntries | null {
		if (!this.store.getTask(taskId)) return null;
		const journalPath = join(this.config.paths.runsDir, taskId, "journal.db");
		if (!existsSync(journalPath)) return { agents: [], humans: [] };
		const journal = new Journal(journalPath);
		try {
			return journal.listAll();
		} finally {
			journal.close();
		}
	}

	getScript(taskId: string): string | null {
		const task = this.store.getTask(taskId);
		if (!task) return null;
		if (!existsSync(task.workflow_path)) return null;
		return readFileSync(task.workflow_path, "utf8");
	}

	getArtifacts(taskId: string): string[] | null {
		if (!this.store.getTask(taskId)) return null;
		const dir = join(this.config.paths.runsDir, taskId, "debug", "artifacts");
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.sort();
	}

	getArtifact(taskId: string, name: string): unknown | null {
		if (!this.store.getTask(taskId)) return null;
		const safe = basename(name);
		if (!safe || !safe.endsWith(".json")) return null;
		const filePath = join(this.config.paths.runsDir, taskId, "debug", "artifacts", safe);
		if (!existsSync(filePath)) return null;
		return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
	}

	rerun(taskId: string, overrides: { args?: unknown; options?: Partial<TaskOptions> } = {}): CreateTaskResult {
		const task = this.store.getTask(taskId);
		if (!task) throw new Error(`Task not found: ${taskId}`);
		if (!existsSync(task.workflow_path)) throw new Error(`Workflow script not found for task: ${taskId}`);

		const script = readFileSync(task.workflow_path, "utf8");
		const originalOptions = JSON.parse(task.options) as TaskOptions;
		const mergedOptions = { ...originalOptions, ...overrides.options };

		const newTaskId = this.allocateTaskId();
		const newRunDir = join(this.config.paths.runsDir, newTaskId);
		mkdirSync(newRunDir, { recursive: true });

		// Copy journal from original run so cached agent results are reused
		const originalJournalPath = join(this.config.paths.runsDir, taskId, "journal.db");
		if (existsSync(originalJournalPath)) {
			copyFileSync(originalJournalPath, join(newRunDir, "journal.db"));
		}

		const workflowPath = join(newRunDir, "workflow.js");
		writeFileSync(workflowPath, script, "utf8");

		const now = Date.now();
		this.store.insertTask({
			id: newTaskId,
			workflow_source: task.workflow_source,
			workflow_name: task.workflow_name,
			workflow_path: workflowPath,
			status: "created",
			base_repo: task.base_repo,
			base_branch: task.base_branch,
			cwd: mergedOptions?.cwd ?? task.cwd,
			created_at: now,
			started_at: null,
			finished_at: null,
			error: null,
			options: JSON.stringify(mergedOptions ?? {}),
			result: null,
		});

		this.events.emit(
			"task.created",
			{ taskId: newTaskId, runDir: newRunDir, workflowPath, rerunOf: taskId },
			newTaskId,
		);
		void this.run(newTaskId, script, overrides.args, mergedOptions).catch(() => undefined);
		return { task_id: newTaskId, run_dir: newRunDir, workflow_path: workflowPath, rerun_of: taskId };
	}

	// === workflow store delegation ===

	listWorkflows(): WorkflowInfo[] {
		return this.workflowStore.list();
	}

	getWorkflow(name: string): WorkflowInfo | null {
		return this.workflowStore.get(name);
	}

	putWorkflow(name: string, script: string): void {
		this.workflowStore.put(name, script);
	}

	deleteWorkflow(name: string): boolean {
		return this.workflowStore.delete(name);
	}

	save(taskId: string, name: string): void {
		if (!name?.trim()) throw new Error("name is required");
		if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
			throw new Error("name must contain only alphanumeric characters, hyphens, and underscores");
		}
		const task = this.store.getTask(taskId);
		if (!task) throw new Error(`Task not found: ${taskId}`);
		if (!existsSync(task.workflow_path)) throw new Error(`Workflow script not found for task: ${taskId}`);

		const script = readFileSync(task.workflow_path, "utf8");
		const dest = join(this.config.paths.workflowsDir, `${name}.js`);
		writeFileSync(dest, script, "utf8");
	}

	abort(taskId: string): void {
		this.controllers.get(taskId)?.abort();
		this.store.updateTask(taskId, { status: "aborted", finished_at: Date.now() });
		this.events.emit("task.aborted", { taskId }, taskId);
		this.logger.forTask(taskId).info("task aborted");
	}

	async merge(taskId: string): Promise<{ success: boolean; mergeCommit?: string; error?: string }> {
		const task = this.store.getTask(taskId);
		if (!task) return { success: false, error: `Task not found: ${taskId}` };
		if (task.status !== "finished")
			return { success: false, error: `Task must be finished before merge (current: ${task.status})` };

		const result = await this.isolation.merge(taskId);
		if (result.success) {
			this.events.emit("task.merged", { taskId, mergeCommit: result.mergeCommit }, taskId);
			this.logger.forTask(taskId).info("task merged", { commit: result.mergeCommit ?? "" });
		} else {
			this.logger.forTask(taskId).warn("merge failed", { error: result.error ?? "" });
		}
		return result;
	}

	async reject(taskId: string): Promise<void> {
		const task = this.store.getTask(taskId);
		if (!task) throw new Error(`Task not found: ${taskId}`);

		await this.isolation.reject(taskId);
		this.store.updateTask(taskId, { status: "aborted" });
		this.events.emit("task.rejected", { taskId }, taskId);
		this.logger.forTask(taskId).info("task rejected");
	}

	private async run(taskId: string, script: string, args: unknown, options: TaskOptions = {}): Promise<void> {
		const controller = new AbortController();
		this.controllers.set(taskId, controller);
		const runDir = join(this.config.paths.runsDir, taskId);
		const journal = new Journal(join(runDir, "journal.db"));

		const taskLog = this.logger.forTask(taskId);
		taskLog.info("task running");

		const span = this.tracer.startSpan("workflow.task", {
			attributes: {
				[Attrs.TASK_ID]: taskId,
				[Attrs.TASK_SOURCE]: this.store.getTask(taskId)?.workflow_source ?? "unknown",
			},
		});

		try {
			this.store.updateTask(taskId, { status: "running", started_at: Date.now() });
			this.events.emit("task.running", { taskId }, taskId);

			const result = await runWorkflow(script, {
				args,
				taskId,
				cwd: options.cwd,
				model: options.model ?? this.config.defaults.model ?? undefined,
				concurrency: options.concurrency ?? this.config.defaults.concurrency,
				tokenBudget: options.token_budget ?? this.config.defaults.tokenBudget,
				signal: controller.signal,
				rolesDir: this.config.paths.rolesDir,
				agentDir: this.resolveAgentDir(),
				inheritPiSettings: this.config.models.inheritPiSettings,
				disableSubagentCompaction: this.config.models.disableSubagentCompaction,
				authPath: this.config.models.authPath ?? undefined,
				modelsPath: this.config.models.modelsPath ?? undefined,
				journal,
				agentJournal: journal,
				isolationManager: this.isolation,
				human: {
					createRequest: ({ requestId, cacheKey, request }) => {
						this.store.insertNeedsHuman({
							request_id: requestId,
							task_id: taskId,
							cache_key: cacheKey,
							payload: JSON.stringify(request),
							status: "pending",
							created_at: Date.now(),
							resolved_at: null,
							response: null,
						});
						this.store.updateTask(taskId, { status: "needs_human" });
						this.events.emit("task.needs_human", { taskId, requestId, request }, taskId);
					},
					wait: (requestId, signal) => this.humanGate.wait(requestId, signal),
				},
				onLog: (message) => this.events.emit("workflow.log", { taskId, message }, taskId),
				onPhase: (phase) => {
					this.store.endCurrentPhase(taskId, Date.now());
					this.store.insertPhase({ task_id: taskId, phase, started_at: Date.now(), ended_at: null });
					this.events.emit("workflow.phase", { taskId, phase }, taskId);
				},
				onAgentStart: (event) => this.events.emit("workflow.agent_started", { taskId, ...event }, taskId),
				onAgentEnd: (event) => this.events.emit("workflow.agent_completed", { taskId, ...event }, taskId),
			});

			this.store.endCurrentPhase(taskId, Date.now());
			this.store.updateTask(taskId, {
				status: "finished",
				finished_at: Date.now(),
				result: JSON.stringify(result.result),
			});
			this.events.emit("task.finished", { taskId, result: result.result }, taskId);
			span.setStatus({ code: SpanStatusCode.OK });
			span.setAttribute(Attrs.TASK_STATUS, "finished");
			taskLog.info("task finished");
			void this.isolation.finalizeWorktrees(taskId, "approved");
		} catch (error) {
			const aborted = controller.signal.aborted;
			const decision = aborted ? "aborted" : "rejected";
			const finalStatus = aborted ? "aborted" : "failed";
			this.store.updateTask(taskId, {
				status: finalStatus,
				finished_at: Date.now(),
				error: error instanceof Error ? error.message : String(error),
			});
			this.events.emit(aborted ? "task.aborted" : "task.failed", { taskId, error: String(error) }, taskId);
			span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
			span.setAttribute(Attrs.TASK_STATUS, finalStatus);
			if (error instanceof Error) span.recordException(error);
			taskLog.info(`task ${finalStatus}`, {
				error: error instanceof Error ? error.message : String(error),
			});
			void this.isolation.finalizeWorktrees(taskId, decision);
		} finally {
			span.end();
			journal.close();
			this.controllers.delete(taskId);
		}
	}

	private allocateTaskId(): string {
		while (true) {
			const id = `T-${String(this.nextTaskSeq++).padStart(4, "0")}`;
			if (!this.store.getTask(id) && !existsSync(join(this.config.paths.runsDir, id))) return id;
		}
	}

	private resolveAgentDir(): string | undefined {
		return this.config.models.agentDir ?? this.config.models.piAgentDir ?? undefined;
	}

	private resolveAuthor(): WorkflowAuthor {
		// Use stub when no auth is configured (tests, offline mode).
		// Real LLM author is used when pi auth is available.
		const agentDir = this.resolveAgentDir();
		if (!agentDir) return new StubWorkflowAuthor();
		try {
			return new LlmWorkflowAuthor({
				agentDir,
				authPath: this.config.models.authPath ?? undefined,
				modelsPath: this.config.models.modelsPath ?? undefined,
				model: this.config.defaults.model ?? undefined,
			});
		} catch {
			return new StubWorkflowAuthor();
		}
	}
}

const noopSpan = {
	setAttribute() {
		return this;
	},
	setStatus() {
		return this;
	},
	recordException() {},
	end() {},
} as const;

function createNoopLogger(): TracingLogger {
	const noop = () => {};
	const self: TracingLogger = {
		info: noop,
		warn: noop,
		error: noop,
		debug: noop,
		forTask: () => self,
		forComponent: () => self,
	} as unknown as TracingLogger;
	return self;
}
