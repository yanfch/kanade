import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KanadeConfig } from "../config/index.ts";
import type { HumanGate } from "../human/index.ts";
import { Journal } from "../journal/index.ts";
import type { NeedsHumanRow, StateStore, TaskRow, TaskStatus } from "../store/index.ts";
import { runWorkflow } from "../workflow-engine/index.ts";
import type { EventBus } from "./event-bus.ts";

export interface CreateTaskInput {
	source: "inline";
	script: string;
	args?: unknown;
	options?: {
		cwd?: string;
		model?: string;
		concurrency?: number;
		token_budget?: number;
	};
}

export interface CreateTaskResult {
	task_id: string;
	run_dir: string;
	workflow_path: string;
}

export class TaskManager {
	private nextTaskSeq = 1;
	private readonly controllers = new Map<string, AbortController>();

	constructor(
		private readonly config: KanadeConfig,
		private readonly store: StateStore,
		private readonly events: EventBus,
		private readonly humanGate: HumanGate,
	) {}

	create(input: CreateTaskInput): CreateTaskResult {
		if (input.source !== "inline") throw new Error("TaskManager MVP only supports source=inline");
		if (!input.script?.trim()) throw new Error("script is required");

		const taskId = this.allocateTaskId();
		const runDir = join(this.config.paths.runsDir, taskId);
		mkdirSync(runDir, { recursive: true });
		const workflowPath = join(runDir, "workflow.js");
		writeFileSync(workflowPath, input.script, "utf8");

		const cwd = input.options?.cwd ?? process.cwd();
		const now = Date.now();
		this.store.insertTask({
			id: taskId,
			workflow_source: "inline",
			workflow_name: null,
			workflow_path: workflowPath,
			status: "created",
			base_repo: null,
			base_branch: this.config.isolation.defaultBaseBranch,
			cwd,
			created_at: now,
			started_at: null,
			finished_at: null,
			error: null,
			options: JSON.stringify(input.options ?? {}),
			result: null,
		});

		this.events.emit("task.created", { taskId, runDir, workflowPath }, taskId);
		void this.run(taskId, input.script, input.args, input.options).catch(() => undefined);
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

	abort(taskId: string): void {
		this.controllers.get(taskId)?.abort();
		this.store.updateTask(taskId, { status: "aborted", finished_at: Date.now() });
		this.events.emit("task.aborted", { taskId }, taskId);
	}

	private async run(
		taskId: string,
		script: string,
		args: unknown,
		options: CreateTaskInput["options"] = {},
	): Promise<void> {
		const controller = new AbortController();
		this.controllers.set(taskId, controller);
		const runDir = join(this.config.paths.runsDir, taskId);
		const journal = new Journal(join(runDir, "journal.db"));

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
		} catch (error) {
			const aborted = controller.signal.aborted;
			this.store.updateTask(taskId, {
				status: aborted ? "aborted" : "failed",
				finished_at: Date.now(),
				error: error instanceof Error ? error.message : String(error),
			});
			this.events.emit(aborted ? "task.aborted" : "task.failed", { taskId, error: String(error) }, taskId);
		} finally {
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
}
