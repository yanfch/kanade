import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@earendil-works/pi-coding-agent";
import { type Context, type Span, SpanStatusCode, type Tracer, context, trace } from "@opentelemetry/api";
import type { KanadeConfig } from "../config/index.ts";
import type { HumanGate } from "../human/index.ts";
import { IsolationManager } from "../isolation/index.ts";
import { Journal, type JournalAllEntries } from "../journal/index.ts";
import type { NeedsHumanRow, StateStore, TaskRow, TaskStatus, WorkflowSource, WorktreeRow } from "../store/index.ts";
import * as Attrs from "../tracing/attributes.ts";
import type { TracingHandle, Logger as TracingLogger } from "../tracing/index.ts";
import { runWorkflow, validateSemanticWorkflowScript } from "../workflow-engine/index.ts";
import { SnapshotBuilder } from "../workflow-engine/snapshot-builder.ts";
import type { WorkflowSnapshot } from "../workflow-engine/snapshot.ts";
import { AppError } from "./errors.ts";
import type { EventBus } from "./event-bus.ts";
import { buildIterateWorkflowScript } from "./iterate-workflow.ts";
import { LlmWorkflowAuthor, StubWorkflowAuthor, type WorkflowAuthor } from "./workflow-author.ts";
import { type WorkflowInfo, WorkflowStore } from "./workflow-store.ts";

export interface TaskOptions {
	cwd?: string;
	model?: string;
	concurrency?: number;
	token_budget?: number;
	/** Per-task cost limit in USD. Overrides global default. */
	cost_budget?: number;
	/** Per-agent timeout in milliseconds. 0 disables timeout. Overrides global default. */
	agent_timeout_ms?: number;
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

export interface GenerateWorkflowResult {
	script: string;
}

interface TaskTrace {
	span: Span;
	context: Context;
}

export class TaskManager {
	private nextTaskSeq = 1;
	private readonly controllers = new Map<string, AbortController>();
	private readonly workflowStore: WorkflowStore;
	private readonly author: WorkflowAuthor;
	private readonly isolation: IsolationManager;
	/** Exposed for CleanupScheduler access. */
	readonly isolationManager: IsolationManager;

	// Daily cost tracking
	private dailyCostDate = new Date().toISOString().slice(0, 10);
	private dailyCostTotal = 0;

	private readonly logger: TracingLogger;
	private readonly tracer: Tracer;
	private readonly snapshotBuilder: SnapshotBuilder;
	private readonly createSession?: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;

	constructor(
		private readonly config: KanadeConfig,
		private readonly store: StateStore,
		private readonly events: EventBus,
		private readonly humanGate: HumanGate,
		author?: WorkflowAuthor,
		tracing?: TracingHandle,
		sessionFactory?: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>,
	) {
		this.createSession = sessionFactory;
		this.workflowStore = new WorkflowStore(config.paths.workflowsDir);
		this.author = author ?? this.resolveAuthor();
		this.isolation = new IsolationManager(
			store,
			{
				defaultBaseBranch: config.isolation.defaultBaseBranch,
				defaultBaseRepo: config.isolation.defaultBaseRepo,
				worktreeBaseDir: config.isolation.worktreeBaseDir,
				branchPrefix: config.isolation.branchPrefix,
				autoCleanupOnReject: config.isolation.autoCleanupOnReject,
				autoCleanupOnApprove: config.isolation.autoCleanupOnApprove,
				autoCleanupOnAbort: config.isolation.autoCleanupOnAbort,
			},
			config.merge,
		);
		this.logger = tracing?.logger.forComponent("task-manager") ?? createNoopLogger();
		this.tracer = tracing?.tracer ?? ({ startSpan: () => noopSpan } as unknown as Tracer);
		this.isolationManager = this.isolation;
		this.snapshotBuilder = new SnapshotBuilder(events);
	}

	async generateWorkflow(prompt: string, options?: TaskOptions): Promise<GenerateWorkflowResult> {
		if (!prompt?.trim()) throw new AppError("prompt is required", 400);
		const script = await this.author.generate(prompt, { model: options?.model });
		validateSemanticWorkflowScript(script);
		return { script };
	}

	create(input: CreateTaskInput): CreateTaskResult {
		if (input.source === "saved") {
			if (!input.workflow_name?.trim()) throw new AppError("workflow_name is required", 400);
			const workflow = this.workflowStore.get(input.workflow_name);
			if (!workflow) throw new AppError(`Workflow not found: ${input.workflow_name}`, 404);
			return this.createFromScript("saved", input.workflow_name, workflow.script, input.args, input.options);
		}
		if (input.source === "generated") {
			if (!input.prompt?.trim()) throw new AppError("prompt is required", 400);
			return this.createGenerated(input.prompt, input.args, input.options);
		}
		if (!input.script?.trim()) throw new AppError("script is required", 400);
		return this.createFromScript("inline", null, input.script, input.args, input.options);
	}

	private createGenerated(prompt: string, args: unknown, options: TaskOptions | undefined): CreateTaskResult {
		const taskId = this.allocateTaskId();
		const runDir = join(this.config.paths.runsDir, taskId);
		mkdirSync(runDir, { recursive: true });
		const workflowPath = join(runDir, "workflow.js");
		const base = this.resolveTaskBase();

		const now = Date.now();
		this.store.insertTask({
			id: taskId,
			workflow_source: "generated",
			workflow_name: null,
			workflow_path: workflowPath,
			status: "created",
			base_repo: base.baseRepo,
			base_branch: base.baseBranch,
			cwd: options?.cwd ?? process.cwd(),
			created_at: now,
			started_at: null,
			finished_at: null,
			error: null,
			options: JSON.stringify(options ?? {}),
			result: null,
		});

		const taskTrace = this.startTaskTrace(taskId, "generated");
		this.events.emit("task.created", { taskId, runDir, workflowPath }, taskId);
		this.logger.forTask(taskId).withContext(taskTrace.context).info("task created", { source: "generated" });
		void this.runGenerated(taskId, workflowPath, prompt, args, options, taskTrace).catch(() => undefined);
		return { task_id: taskId, run_dir: runDir, workflow_path: workflowPath, generated: true };
	}

	private async runGenerated(
		taskId: string,
		workflowPath: string,
		prompt: string,
		args: unknown,
		options: TaskOptions | undefined,
		taskTrace: TaskTrace,
	): Promise<void> {
		try {
			const authorSpan = this.tracer.startSpan(
				"workflow.author",
				{ attributes: { [Attrs.TASK_ID]: taskId, "kanade.author.model": options?.model ?? "" } },
				taskTrace.context,
			);
			let script: string;
			try {
				script = await this.author.generate(prompt, { model: options?.model });
				authorSpan.setStatus({ code: SpanStatusCode.OK });
			} catch (error) {
				authorSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
				if (error instanceof Error) authorSpan.recordException(error);
				throw error;
			} finally {
				authorSpan.end();
			}
			writeFileSync(workflowPath, script, "utf8");
			validateSemanticWorkflowScript(script);
			this.logger.forTask(taskId).withContext(taskTrace.context).info("workflow script generated", {
				model: options?.model,
			});
			this.events.emit("task.script_generated", { taskId, workflowPath }, taskId);
			await this.run(taskId, script, args, options, taskTrace);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			this.store.updateTask(taskId, { status: "failed", finished_at: Date.now(), error: msg });
			this.events.emit("task.failed", { taskId, error: msg }, taskId);
			taskTrace.span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
			taskTrace.span.setAttribute(Attrs.TASK_STATUS, "failed");
			if (error instanceof Error) taskTrace.span.recordException(error);
			this.logger.forTask(taskId).withContext(taskTrace.context).info("task failed", { error: msg });
			taskTrace.span.end();
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
		const base = this.resolveTaskBase();

		const now = Date.now();
		this.store.insertTask({
			id: taskId,
			workflow_source: source,
			workflow_name: workflowName,
			workflow_path: workflowPath,
			status: "created",
			base_repo: base.baseRepo,
			base_branch: base.baseBranch,
			cwd: options?.cwd ?? process.cwd(),
			created_at: now,
			started_at: null,
			finished_at: null,
			error: null,
			options: JSON.stringify(options ?? {}),
			result: null,
		});

		const taskTrace = this.startTaskTrace(taskId, source);
		this.events.emit("task.created", { taskId, runDir, workflowPath }, taskId);
		this.logger.forTask(taskId).withContext(taskTrace.context).info("task created", { source });
		void this.run(taskId, script, args, options, taskTrace).catch(() => undefined);
		return { task_id: taskId, run_dir: runDir, workflow_path: workflowPath };
	}

	iterate(parentTaskId: string, options: { instructions?: string; args?: unknown } = {}): CreateTaskResult {
		const parentTask = this.store.getTask(parentTaskId);
		if (!parentTask) throw new AppError(`Task not found: ${parentTaskId}`, 404);

		const normalizedInstructions = typeof options.instructions === "string" ? options.instructions.trim() : "";
		if (!normalizedInstructions) throw new AppError("instructions are required", 400);

		const script = buildIterateWorkflowScript();
		const parentOptions = JSON.parse(parentTask.options) as TaskOptions;

		// Find worktree branch from parent task
		const worktrees = this.store.findWorktreesByTask(parentTaskId);
		const reuseBranch = worktrees.length > 0 ? worktrees[0].branch : undefined;
		const userArgs =
			options.args && typeof options.args === "object" && !Array.isArray(options.args)
				? (options.args as Record<string, unknown>)
				: {};
		const previousResult = parentTask.result ? (JSON.parse(parentTask.result) as unknown) : null;

		// Build args with iteration context
		const iterateArgs = {
			...userArgs,
			previousTaskId: parentTaskId,
			previousResult: previousResult == null ? null : JSON.parse(JSON.stringify(previousResult)),
			instructions: normalizedInstructions,
			reuseBranch,
		};

		const newTaskId = this.allocateTaskId();
		const newRunDir = join(this.config.paths.runsDir, newTaskId);
		mkdirSync(newRunDir, { recursive: true });
		const workflowPath = join(newRunDir, "workflow.js");
		writeFileSync(workflowPath, script, "utf8");

		const now = Date.now();
		this.store.insertTask({
			id: newTaskId,
			workflow_source: parentTask.workflow_source,
			workflow_name: parentTask.workflow_name,
			workflow_path: workflowPath,
			status: "created",
			base_repo: parentTask.base_repo,
			base_branch: parentTask.base_branch,
			cwd: parentOptions?.cwd ?? parentTask.cwd,
			created_at: now,
			started_at: null,
			finished_at: null,
			error: null,
			options: JSON.stringify(parentOptions ?? {}),
			result: null,
		});

		// Record iteration link
		this.store.insertIteration({
			id: `iter-${newTaskId}`,
			task_id: newTaskId,
			parent_task_id: parentTaskId,
			instructions: normalizedInstructions,
			reuse_branch: reuseBranch ?? null,
			created_at: now,
		});

		this.events.emit(
			"task.created",
			{ taskId: newTaskId, runDir: newRunDir, workflowPath, iterateFrom: parentTaskId },
			newTaskId,
		);
		const taskTrace = this.startTaskTrace(newTaskId, parentTask.workflow_source);
		this.logger
			.forTask(newTaskId)
			.withContext(taskTrace.context)
			.info("task created", {
				source: "iterate",
				parent: parentTaskId,
				instructions: normalizedInstructions ?? "",
			});
		void this.run(newTaskId, script, iterateArgs, parentOptions, taskTrace).catch(() => undefined);
		return { task_id: newTaskId, run_dir: newRunDir, workflow_path: workflowPath };
	}

	get(taskId: string): TaskRow | null {
		return this.store.getTask(taskId);
	}

	private resolveTaskBase(): { baseRepo: string; baseBranch: string } {
		const baseRepo = this.config.isolation.defaultBaseRepo ?? process.cwd();
		try {
			const branch = execSync("git rev-parse --abbrev-ref HEAD", {
				cwd: baseRepo,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			if (branch) return { baseRepo, baseBranch: branch };
		} catch {
			// Fall back to configured default when git branch detection is unavailable.
		}
		return { baseRepo, baseBranch: this.config.isolation.defaultBaseBranch };
	}

	list(status?: TaskStatus): TaskRow[] {
		return this.store.listTasks({ status });
	}

	inbox(): NeedsHumanRow[] {
		return this.store.listPendingNeedsHuman();
	}

	respond(taskId: string, requestId: string, response: unknown): void {
		const row = this.store.getNeedsHuman(requestId);
		if (!row || row.task_id !== taskId) throw new AppError(`Human request not found for task: ${requestId}`, 404);
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

	getIteration(taskId: string): {
		iteration: import("../store/index.ts").TaskIterationRow | null;
		chain: string[];
	} {
		const iteration = this.store.getIterationByTask(taskId);
		const chain = this.store.getIterationChain(taskId).map((r) => r.task_id);
		return { iteration, chain };
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
		const taskTrace = this.startTaskTrace(newTaskId, task.workflow_source);
		this.logger
			.forTask(newTaskId)
			.withContext(taskTrace.context)
			.info("task created", { source: "rerun", rerunOf: taskId });
		void this.run(newTaskId, script, overrides.args, mergedOptions, taskTrace).catch(() => undefined);
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

	async abort(taskId: string): Promise<void> {
		const task = this.store.getTask(taskId);
		if (!task) return;
		if (task.status === "aborted" || task.status === "failed" || task.status === "finished") return;

		const controller = this.controllers.get(taskId);
		if (controller) {
			controller.abort();
			return;
		}

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

	private get runningCount(): number {
		return this.controllers.size;
	}

	private async run(
		taskId: string,
		script: string,
		args: unknown,
		options: TaskOptions = {},
		taskTrace = this.startTaskTrace(taskId, this.store.getTask(taskId)?.workflow_source ?? "unknown"),
	): Promise<void> {
		const controller = new AbortController();
		this.controllers.set(taskId, controller);
		const runDir = join(this.config.paths.runsDir, taskId);
		const journal = new Journal(join(runDir, "journal.db"));

		const span = taskTrace.span;
		const traceContext = taskTrace.context;
		const taskLog = this.logger.forTask(taskId).withContext(traceContext);

		try {
			// Rate limiting
			const max = this.config.defaults.maxConcurrentTasks;
			if (max > 0 && this.runningCount > max) {
				throw new AppError(
					`Too many concurrent tasks (${this.runningCount - 1}/${max}). Wait for existing tasks to finish.`,
					429,
				);
			}

			if (this.store.getTask(taskId)?.status === "aborted") {
				span.setStatus({ code: SpanStatusCode.OK });
				span.setAttribute(Attrs.TASK_STATUS, "aborted");
				taskLog.info("task already aborted before run started");
				return;
			}

			this.checkDailyBudget();
			taskLog.info("task running");
			this.store.updateTask(taskId, { status: "running", started_at: Date.now() });
			this.events.emit("task.running", { taskId }, taskId);

			// Initialize snapshot for real-time progress tracking
			const scriptMeta = this.parseScriptMeta(script);
			if (scriptMeta) this.snapshotBuilder.init(taskId, scriptMeta);

			const result = await runWorkflow(script, {
				args,
				taskId,
				cwd: options.cwd,
				model: options.model ?? this.config.defaults.model ?? undefined,
				concurrency: options.concurrency ?? this.config.defaults.concurrency,
				tokenBudget: options.token_budget ?? this.config.defaults.tokenBudget,
				costBudget: options.cost_budget ?? this.config.defaults.costBudget,
				agentTimeoutMs: options.agent_timeout_ms ?? this.config.defaults.agentTimeoutMs,
				signal: controller.signal,
				tracer: this.tracer,
				traceContext,
				rolesDir: this.config.paths.rolesDir,
				agentDir: this.resolveAgentDir(),
				...(this.createSession ? { createSession: this.createSession } : {}),
				inheritPiSettings: this.config.models.inheritPiSettings,
				disableSubagentCompaction: this.config.models.disableSubagentCompaction,
				authPath: this.config.models.authPath ?? undefined,
				modelsPath: this.config.models.modelsPath ?? undefined,
				dumpArtifacts: this.config.debug.dumpArtifacts,
				runDir,
				persistSubagents: this.config.debug.persistSubagents,
				persistFilter: this.buildPersistFilter(),
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
						taskLog.info("needs human input", { requestId });
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
				onUsage: (usage) => {
					this.addDailyCost(usage.cost.total);
				},
			});

			this.store.endCurrentPhase(taskId, Date.now());
			try {
				await this.isolation.finalizeWorktrees(taskId, "approved");
			} catch (cleanupError) {
				taskLog.warn("worktree finalization failed after successful task", {
					error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
				});
			}
			this.store.updateTask(taskId, {
				status: "finished",
				finished_at: Date.now(),
				result: JSON.stringify(result.result),
				usage: JSON.stringify(result.usage),
			});
			this.events.emit("task.finished", { taskId, result: result.result }, taskId);
			span.setStatus({ code: SpanStatusCode.OK });
			span.setAttribute(Attrs.TASK_STATUS, "finished");
			taskLog.info("task finished");
		} catch (error) {
			const aborted = controller.signal.aborted;
			const decision = aborted ? "aborted" : "rejected";
			const finalStatus = aborted ? "aborted" : "failed";
			try {
				await this.isolation.finalizeWorktrees(taskId, decision);
			} catch (cleanupError) {
				taskLog.warn("worktree finalization failed after task error", {
					error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
				});
			}
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
		} finally {
			span.end();
			journal.close();
			this.controllers.delete(taskId);
		}
	}

	private startTaskTrace(taskId: string, source: string): TaskTrace {
		const span = this.tracer.startSpan("workflow.task", {
			attributes: {
				[Attrs.TASK_ID]: taskId,
				[Attrs.TASK_SOURCE]: source,
			},
		});
		return { span, context: trace.setSpan(context.active(), span) };
	}

	private allocateTaskId(): string {
		const prefix = this.config.defaults.taskIdPrefix ?? "T";
		while (true) {
			const id = `${prefix}-${String(this.nextTaskSeq++).padStart(4, "0")}`;
			if (!this.store.getTask(id) && !existsSync(join(this.config.paths.runsDir, id)) && !this.taskBranchExists(id)) {
				return id;
			}
		}
	}

	private taskBranchExists(taskId: string): boolean {
		const baseRepo = this.config.isolation.defaultBaseRepo ?? process.cwd();
		const branch = `${this.config.isolation.branchPrefix}/${taskId}`;
		try {
			execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
				cwd: baseRepo,
				stdio: "ignore",
			});
			return true;
		} catch {
			return false;
		}
	}

	private resolveAgentDir(): string | undefined {
		return this.config.models.agentDir ?? this.config.models.piAgentDir ?? undefined;
	}

	/** Add cost to daily tracker (never throws). */
	private addDailyCost(cost: number): void {
		const today = new Date().toISOString().slice(0, 10);
		if (today !== this.dailyCostDate) {
			this.dailyCostDate = today;
			this.dailyCostTotal = 0;
		}
		this.dailyCostTotal += cost;
	}

	/** Check if daily budget is exceeded. Call before starting a new task. */
	private checkDailyBudget(): void {
		const today = new Date().toISOString().slice(0, 10);
		if (today !== this.dailyCostDate) {
			this.dailyCostDate = today;
			this.dailyCostTotal = 0;
		}
		const limit = this.config.defaults.dailyCostBudget;
		if (limit > 0 && this.dailyCostTotal > limit) {
			throw new AppError(
				`Daily cost budget exceeded: $${this.dailyCostTotal.toFixed(4)} > $${limit.toFixed(2)} daily limit. No more tasks will run until tomorrow or budget is increased.`,
				429,
			);
		}
	}

	/** Get the current snapshot for a task (real-time progress). */
	getSnapshot(taskId: string): WorkflowSnapshot | null {
		return this.snapshotBuilder.get(taskId);
	}

	/** Get worktrees for a task. */
	getWorktrees(taskId: string): WorktreeRow[] {
		return this.store.findWorktreesByTask(taskId);
	}

	/** Get persisted task-level usage data from tasks.usage. Returns null if task has no usage data. */
	getUsage(taskId: string): Record<string, unknown> | null {
		return this.store.getTaskUsage(taskId);
	}

	private parseScriptMeta(script: string): { name: string; description: string } | null {
		try {
			const match = script.match(/export\s+const\s+meta\s*=\s*\{/);
			if (!match) return null;
			const nameMatch = script.match(/name\s*:\s*['"]([^'"]+)['"]\s*,/);
			const descMatch = script.match(/description\s*:\s*['"]([^'"]+)['"]/);
			return {
				name: nameMatch?.[1] ?? "workflow",
				description: descMatch?.[1] ?? "",
			};
		} catch {
			return null;
		}
	}

	private buildPersistFilter(): ((label: string) => boolean) | undefined {
		const filter = this.config.debug.persistFilter;
		if (!filter) return undefined;
		return (label: string) => {
			if (filter.labels?.length && filter.labels.some((l) => label.includes(l))) return true;
			return false;
		};
	}

	private resolveAuthor(): WorkflowAuthor {
		// Use stub when no auth is configured (tests, offline mode).
		// Real LLM author is used when pi auth is available.
		const agentDir = this.resolveAgentDir();
		if (!agentDir) return new StubWorkflowAuthor();
		try {
			const persistDir = this.config.debug.persistSubagents
				? join(this.config.paths.runsDir, "debug", "workflow-author")
				: undefined;
			return new LlmWorkflowAuthor({
				agentDir,
				authPath: this.config.models.authPath ?? undefined,
				modelsPath: this.config.models.modelsPath ?? undefined,
				model: this.config.defaults.model ?? undefined,
				persistDir,
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
		withContext: () => self,
	} as unknown as TracingLogger;
	return self;
}
