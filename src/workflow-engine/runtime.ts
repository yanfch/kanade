// Portions of this file are derived from pi-dynamic-workflows
// (https://github.com/Michaelliv/pi-dynamic-workflows), MIT licensed.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { type Context, SpanStatusCode, type Tracer } from "@opentelemetry/api";
import type { Node } from "acorn";
import { parse } from "acorn";
import type { TSchema } from "typebox";
import type { HumanRequest, HumanResponse } from "../human/index.ts";
import type { IsolationManager } from "../isolation/index.ts";
import { hashHumanRequest } from "../journal/index.ts";
import * as Attrs from "../tracing/attributes.ts";
import { type SessionUsage, WorkflowAgent, type WorkflowAgentOptions } from "./workflow-agent.ts";

export interface WorkflowMetaPhase {
	title: string;
	detail?: string;
	model?: string;
}

export interface WorkflowMeta {
	name: string;
	description: string;
	whenToUse?: string;
	phases?: WorkflowMetaPhase[];
}

export interface WorkflowRunOptions extends Omit<WorkflowAgentOptions, "journal" | "defaultModel"> {
	args?: unknown;
	taskId?: string;
	/** Default subagent model used when neither the helper call nor the role specifies one. */
	agentModel?: string;
	/** Per-role model overrides for semantic helpers. */
	roleModels?: Record<string, string>;
	agent?: Pick<WorkflowAgent, "run">;
	journal?: WorkflowJournal;
	agentJournal?: WorkflowAgentOptions["journal"];
	isolationManager?: Pick<IsolationManager, "prepare" | "commitDirtyWorktree">;
	human?: WorkflowHumanGate;
	concurrency?: number;
	tokenBudget?: number | null;
	/** Per-task cost limit in USD. Task throws when exceeded. */
	costBudget?: number | null;
	/** Per-agent timeout in milliseconds. 0 disables timeout. */
	agentTimeoutMs?: number | null;
	signal?: AbortSignal;
	tracer?: Tracer;
	/** Parent trace context used for workflow child spans. */
	traceContext?: Context;
	/** Write each agent result to debug/artifacts/<seq>-<label>.json */
	dumpArtifacts?: boolean;
	/** Base directory for artifact dump (usually the run dir) */
	runDir?: string;
	/** Persist subagent sessions to disk. Default: false */
	persistSubagents?: boolean;
	/** Filter which subagent labels get persisted. Return true to persist. */
	persistFilter?: (label: string) => boolean;
	onLog?: (message: string) => void;
	onUsage?: (usage: SessionUsage) => void;
	onPhase?: (title: string) => void;
	onHumanRequest?: (event: { requestId: string; cacheKey: string; request: HumanRequest }) => void;
	onAgentStart?: (event: { label: string; phase?: string; prompt: string }) => void;
	onAgentEnd?: (event: { label: string; phase?: string; result: unknown }) => void;
}

export interface WorkflowJournal {
	lookupHuman<T = unknown>(cacheKey: string): { response: T } | null;
	writeHuman<T = unknown>(cacheKey: string, response: T): void;
}

export interface WorkflowHumanGate {
	createRequest?(input: { requestId: string; cacheKey: string; request: HumanRequest }): void | Promise<void>;
	wait(requestId: string, signal?: AbortSignal): Promise<HumanResponse>;
}

export interface WorkflowUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export interface WorkflowRunResult<T = unknown> {
	meta: WorkflowMeta;
	result: T;
	logs: string[];
	phases: string[];
	agentCount: number;
	durationMs: number;
	usage: WorkflowUsage;
}

export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
	label?: string;
	phase?: string;
	schema?: TSchemaDef;
	role?: string;
	model?: string;
	instructions?: string;
	isolation?: "worktree";
	/** Reuse an existing worktree branch */
	reuseBranch?: string;
	agentType?: string;
	/** Retry configuration for transient failures */
	retry?: { maxRetries: number; backoffMs?: number };
}

interface RuntimeState {
	currentPhase?: string;
	logs: string[];
	phases: string[];
	agentCount: number;
	stepCount: number;
	artifactSeq: number;
	humanCount: number;
	spent: number;
}

export type SemanticStepKind = "analyze" | "implement" | "reviewChange" | "continueImplementation" | "testChange";

export interface SemanticStepResult<T = unknown> {
	id: string;
	kind: SemanticStepKind;
	artifact: T;
	status?: string;
	summary?: string;
	[key: string]: unknown;
}

type AnyNode = Node & {
	[key: string]: unknown;
	body?: AnyNode[];
	declaration?: AnyNode | null;
	kind?: string;
	declarations?: AnyNode[];
	id?: AnyNode;
	name?: string;
	init?: AnyNode;
	properties?: AnyNode[];
	computed?: boolean;
	method?: boolean;
	key?: AnyNode;
	value?: unknown;
	elements?: Array<AnyNode | null>;
	expressions?: AnyNode[];
	quasis?: AnyNode[];
	operator?: string;
	argument?: AnyNode;
};

interface TemplateElementValue {
	cooked?: string | null;
	raw: string;
}

const NONDETERMINISM_ERROR =
	"Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable";
const FORBIDDEN_SEMANTIC_CONTROL_KEYS = new Set(["isolation", "reuseBranch", "agentType", "branch"]);
const SEMANTIC_WORKFLOW_HELPERS = new Set([
	"agent",
	"analyze",
	"implement",
	"reviewChange",
	"continueImplementation",
	"testChange",
]);
const FORBIDDEN_GENERATED_ITERATE_ARGS = new Set(["instructions", "previousResult", "previousTaskId", "reuseBranch"]);

export async function runWorkflow<T = unknown>(
	script: string,
	options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
	const started = Date.now();
	const { meta, body } = parseWorkflowScript(script);
	const state: RuntimeState = {
		logs: [],
		phases: [],
		agentCount: 0,
		stepCount: 0,
		artifactSeq: 0,
		humanCount: 0,
		spent: 0,
	};
	const agentRunner =
		options.agent ??
		new WorkflowAgent({
			...options,
			defaultModel: options.agentModel,
			journal: options.agentJournal,
			isolationManager: options.isolationManager,
			taskId: options.taskId,
			persistSubagents: options.persistSubagents,
			persistFilter: options.persistFilter,
			persistDir: options.runDir ? join(options.runDir, "debug", "subagents") : undefined,
		});
	const concurrency = Math.max(
		1,
		Math.min(options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2), 16),
	);
	const limiter = createLimiter(concurrency);
	const pendingAgentRuns = new Set<Promise<unknown>>();
	const workflowUsage: WorkflowUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const collectUsage = (usage: SessionUsage) => {
		workflowUsage.input += usage.input;
		workflowUsage.output += usage.output;
		workflowUsage.cacheRead += usage.cacheRead;
		workflowUsage.cacheWrite += usage.cacheWrite;
		workflowUsage.totalTokens += usage.totalTokens;
		workflowUsage.cost.input += usage.cost.input;
		workflowUsage.cost.output += usage.cost.output;
		workflowUsage.cost.cacheRead += usage.cost.cacheRead;
		workflowUsage.cost.cacheWrite += usage.cost.cacheWrite;
		workflowUsage.cost.total += usage.cost.total;
	};

	const log = (message: string) => {
		const text = String(message);
		state.logs.push(text);
		options.onLog?.(text);
	};

	const phase = (title: unknown) => {
		const text = requireString(title, "phase title");
		state.currentPhase = text;
		if (!state.phases.includes(text)) state.phases.push(text);
		options.onPhase?.(text);
		options.tracer
			?.startSpan(
				"workflow.phase",
				{
					attributes: {
						[Attrs.PHASE_NAME]: text,
						[Attrs.TASK_ID]: options.taskId ?? "",
					},
				},
				options.traceContext,
			)
			.end();
	};

	const budget = Object.freeze({
		total: options.tokenBudget ?? null,
		spent: () => state.spent,
		remaining: () =>
			options.tokenBudget == null ? Number.POSITIVE_INFINITY : Math.max(0, options.tokenBudget - state.spent),
	});

	const throwIfAborted = () => {
		if (options.signal?.aborted) throw new Error("workflow aborted");
	};

	const agent = async (prompt: unknown, agentOptions: unknown = {}) => {
		throwIfAborted();
		if (budget.total !== null && budget.remaining() <= 0) throw new Error("workflow token budget exhausted");
		const taskPrompt = requireString(prompt, "agent prompt");
		const normalizedOptions = normalizeAgentOptions(agentOptions);
		const assignedPhase = normalizedOptions.phase ?? state.currentPhase;
		const requestedLabel = normalizedOptions.label?.trim();
		const effectiveModel = normalizedOptions.model ?? options.agentModel;
		const run = limiter(async () => {
			state.agentCount++;
			const label = requestedLabel || defaultAgentLabel(assignedPhase, state.agentCount);
			let usageObserved = false;
			let usageTokens = 0;
			let servedFromCache = false;
			const agentSpan = options.tracer?.startSpan(
				"workflow.agent",
				{
					attributes: {
						[Attrs.AGENT_LABEL]: label,
						[Attrs.AGENT_ROLE]: normalizedOptions.role ?? "",
						[Attrs.AGENT_MODEL]: effectiveModel ?? "",
						[Attrs.GEN_AI_USAGE_INPUT_TOKENS]: 0,
						[Attrs.GEN_AI_USAGE_OUTPUT_TOKENS]: 0,
						[Attrs.GEN_AI_USAGE_CACHE_READ]: 0,
						[Attrs.GEN_AI_USAGE_CACHE_CREATION]: 0,
						[Attrs.GEN_AI_USAGE_TOTAL_TOKENS]: 0,
						[Attrs.PHASE_NAME]: assignedPhase ?? "",
						[Attrs.TASK_ID]: options.taskId ?? "",
					},
				},
				options.traceContext,
			);
			options.onAgentStart?.({ label, phase: assignedPhase, prompt: taskPrompt });
			let timeoutCleanup: (() => void) | undefined;
			let timeoutSignal: AbortSignal | undefined;
			try {
				throwIfAborted();
				const timeout = createAgentTimeoutSignal(options.signal, options.agentTimeoutMs, label);
				timeoutSignal = timeout.signal;
				timeoutCleanup = timeout.cleanup;
				const result = await agentRunner.run(taskPrompt, {
					label,
					role: normalizedOptions.role,
					model: effectiveModel,
					schema: normalizedOptions.schema,
					signal: timeout.signal,
					instructions: buildAgentInstructions(assignedPhase, { ...normalizedOptions, model: effectiveModel }),
					isolation: normalizedOptions.isolation,
					reuseBranch: normalizedOptions.reuseBranch,
					...(normalizedOptions.retry ? { retry: normalizedOptions.retry } : {}),
					onCacheHit: () => {
						servedFromCache = true;
					},
					onUsage: (usage: SessionUsage) => {
						usageObserved = true;
						usageTokens = Math.max(usageTokens, usage.totalTokens);
						collectUsage(usage);
						// Check per-task cost budget
						if (options.costBudget != null && workflowUsage.cost.total > options.costBudget) {
							throw new Error(
								`Cost budget exceeded: $${workflowUsage.cost.total.toFixed(4)} > $${options.costBudget.toFixed(2)} limit. Task paused. Worktree preserved.`,
							);
						}
						if (agentSpan) {
							agentSpan.setAttribute(Attrs.GEN_AI_USAGE_INPUT_TOKENS, usage.input);
							agentSpan.setAttribute(Attrs.GEN_AI_USAGE_OUTPUT_TOKENS, usage.output);
							agentSpan.setAttribute(Attrs.GEN_AI_USAGE_CACHE_READ, usage.cacheRead);
							agentSpan.setAttribute(Attrs.GEN_AI_USAGE_CACHE_CREATION, usage.cacheWrite);
							agentSpan.setAttribute(Attrs.GEN_AI_USAGE_TOTAL_TOKENS, usage.totalTokens);
							agentSpan.setAttribute(Attrs.GEN_AI_USAGE_COST_USD, usage.cost.total);
							agentSpan.setAttribute(Attrs.GEN_AI_USAGE_COST_INPUT_USD, usage.cost.input);
							agentSpan.setAttribute(Attrs.GEN_AI_USAGE_COST_OUTPUT_USD, usage.cost.output);
							agentSpan.setAttribute(Attrs.GEN_AI_USAGE_COST_CACHE_READ_USD, usage.cost.cacheRead);
						}
						options.onUsage?.(usage);
					},
				});
				throwIfAborted();
				if (usageObserved) state.spent += usageTokens;
				else if (!servedFromCache) state.spent += estimateTokens(result);
				agentSpan?.setStatus({ code: SpanStatusCode.OK });
				options.onAgentEnd?.({ label, phase: assignedPhase, result });
				dumpArtifact(options, state, label, result);
				return result;
			} catch (error) {
				const finalError = timeoutSignal?.aborted && !options.signal?.aborted ? timeoutSignal.reason || error : error;
				if (options.signal?.aborted) throw finalError;
				agentSpan?.setStatus({ code: SpanStatusCode.ERROR, message: String(finalError) });
				if (finalError instanceof Error) agentSpan?.recordException(finalError);
				log(`agent ${label} failed: ${finalError instanceof Error ? finalError.message : String(finalError)}`);
				options.onAgentEnd?.({ label, phase: assignedPhase, result: null });
				dumpArtifact(options, state, label, null);
				throw finalError;
			} finally {
				timeoutCleanup?.();
				agentSpan?.end();
			}
		});
		pendingAgentRuns.add(run);
		run.then(
			() => pendingAgentRuns.delete(run),
			() => pendingAgentRuns.delete(run),
		);
		return run;
	};

	const parallel = async (thunks: Array<() => Promise<unknown>>, parallelOpts?: { cache_lead?: boolean }) => {
		throwIfAborted();
		if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
		if (thunks.some((thunk) => typeof thunk !== "function")) {
			throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
		}

		const runThunk = async (thunk: () => Promise<unknown>, index: number) => {
			try {
				return await thunk();
			} catch (error) {
				if (options.signal?.aborted) throw error;
				log(`parallel[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
				return null;
			}
		};

		// Lead-first: run the first thunk, wait for it to complete (warming prompt cache),
		// then run the rest in parallel. Useful when all agents share the same role/model.
		if (parallelOpts?.cache_lead && thunks.length >= 2) {
			const first = await runThunk(thunks[0], 0);
			const rest = await Promise.all(thunks.slice(1).map((t, i) => runThunk(t, i + 1)));
			return [first, ...rest];
		}

		return Promise.all(thunks.map((t, i) => runThunk(t, i)));
	};

	const requestHuman = async (request: HumanRequest): Promise<HumanResponse> => {
		throwIfAborted();

		// --- input validation ---
		if (request === null || typeof request !== "object" || Array.isArray(request)) {
			throw new TypeError("request must be a plain object");
		}
		if (typeof request.title !== "string" || !request.title.trim()) {
			throw new TypeError("title must be a non-empty string");
		}
		if (request.options !== undefined) {
			if (!Array.isArray(request.options)) {
				throw new TypeError("options must be an array");
			}
			for (let i = 0; i < request.options.length; i++) {
				if (typeof request.options[i] !== "string" || !request.options[i].trim()) {
					throw new TypeError(`options[${i}] must be a non-empty string`);
				}
			}
		}
		if (request.data !== undefined) {
			if (request.data === null || typeof request.data !== "object" || Array.isArray(request.data)) {
				throw new TypeError("data must be a plain object");
			}
		}
		// --- end input validation ---

		if (!options.human) throw new Error("request_human() is not configured for this workflow run");

		const ordinal = state.humanCount++;
		const cacheKey = hashHumanRequest(request, ordinal);
		const cached = options.journal?.lookupHuman<HumanResponse>(cacheKey);
		if (cached) return cached.response;

		const requestId = `${options.taskId ?? "workflow"}_${ordinal}`;
		const humanSpan = options.tracer?.startSpan(
			"human.request",
			{
				attributes: {
					[Attrs.HUMAN_REQUEST_ID]: requestId,
					[Attrs.TASK_ID]: options.taskId ?? "",
					"human.title": request.title ?? "",
				},
			},
			options.traceContext,
		);
		try {
			await options.human.createRequest?.({ requestId, cacheKey, request });
			options.onHumanRequest?.({ requestId, cacheKey, request });
			const response = await options.human.wait(requestId, options.signal);
			options.journal?.writeHuman(cacheKey, response);
			humanSpan?.setStatus({ code: SpanStatusCode.OK });
			return response;
		} catch (error) {
			humanSpan?.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
			throw error;
		} finally {
			humanSpan?.end();
		}
	};

	const semanticLineage = new WeakMap<object, { implementation: true }>();
	const semanticRoleAvailability = new Map<string, boolean>();
	const canonicalSemanticRoles = new Set(["planner", "developer", "reviewer", "tester"]);

	const createStepResult = <TStep>(kind: SemanticStepKind, artifact: TStep): SemanticStepResult<TStep> => {
		const id = `step_${++state.stepCount}`;
		if (artifact && typeof artifact === "object" && !Array.isArray(artifact)) {
			const base = artifact as Record<string, unknown>;
			return {
				...base,
				id,
				kind,
				artifact,
				...(typeof base.status === "string" ? { status: base.status } : {}),
				...(typeof base.summary === "string" ? { summary: base.summary } : {}),
			} as SemanticStepResult<TStep>;
		}
		return {
			id,
			kind,
			artifact,
			...(typeof artifact === "string" ? { summary: artifact } : {}),
		};
	};

	const markImplementationLineage = <TStep>(result: SemanticStepResult<TStep>): SemanticStepResult<TStep> => {
		semanticLineage.set(result as object, { implementation: true });
		return result;
	};

	const hasImplementationLineage = (value: unknown): boolean => {
		return !!value && typeof value === "object" && semanticLineage.has(value as object);
	};

	const sourceArtifact = (input: unknown): unknown => {
		if (input && typeof input === "object" && "artifact" in (input as Record<string, unknown>)) {
			return (input as Record<string, unknown>).artifact;
		}
		return input;
	};

	const asPromptContext = (value: unknown): string => {
		try {
			return JSON.stringify(sourceArtifact(value));
		} catch {
			return String(value);
		}
	};

	const joinInstructions = (...parts: Array<string | undefined>): string | undefined => {
		const merged = parts.map((part) => part?.trim()).filter((part): part is string => !!part);
		return merged.length > 0 ? merged.join("\n\n") : undefined;
	};

	const isMissingSemanticRoleError = (role: string, error: unknown): boolean => {
		if (!(error instanceof Error)) return false;
		return (
			error.message === `Role not found: ${role}` ||
			error.message === `Role requested but rolesDir is not configured: ${role}`
		);
	};

	const canUseSemanticRole = async (role: string): Promise<boolean> => {
		const cached = semanticRoleAvailability.get(role);
		if (cached !== undefined) return cached;
		if (options.loadRole) {
			try {
				await options.loadRole(role);
				semanticRoleAvailability.set(role, true);
				return true;
			} catch (error) {
				if (!isMissingSemanticRoleError(role, error)) throw error;
				semanticRoleAvailability.set(role, false);
				return false;
			}
		}
		const available = options.rolesDir ? existsSync(join(options.rolesDir, role)) : false;
		semanticRoleAvailability.set(role, available);
		return available;
	};

	const runSemanticAgent = async <TSchemaDef extends TSchema | undefined = undefined>(
		helpName: SemanticStepKind,
		prompt: string,
		input: {
			label?: string;
			role?: string;
			model?: string;
			defaultRole: string;
			fallbackInstructions: string;
			guidance?: string;
			output?: TSchemaDef;
			isolation?: "worktree";
		},
	): Promise<unknown> => {
		const effectiveRole = input.role ?? input.defaultRole;
		const effectiveModel = input.model ?? options.roleModels?.[effectiveRole];
		if (canonicalSemanticRoles.has(effectiveRole) && !(await canUseSemanticRole(effectiveRole))) {
			log(`semantic helper ${helpName} falling back to prompt-only mode because role ${effectiveRole} is unavailable`);
			return agent(prompt, {
				label: input.label,
				model: effectiveModel,
				schema: input.output,
				instructions: joinInstructions(input.fallbackInstructions, input.guidance),
				...(input.isolation ? { isolation: input.isolation } : {}),
			});
		}
		return agent(prompt, {
			label: input.label,
			role: effectiveRole,
			model: effectiveModel,
			schema: input.output,
			instructions: input.guidance,
			...(input.isolation ? { isolation: input.isolation } : {}),
		});
	};

	const implement = async <TSchemaDef extends TSchema | undefined = undefined>(
		prompt: unknown,
		helpOpts: unknown = {},
	): Promise<SemanticStepResult<unknown>> => {
		const taskPrompt = requireString(prompt, "implement prompt");
		const opts = normalizeSemanticStepOptions<TSchemaDef>(helpOpts);
		const result = await runSemanticAgent("implement", taskPrompt, {
			label: opts.label,
			role: opts.role,
			model: opts.model,
			defaultRole: "developer",
			fallbackInstructions:
				"Act as a careful developer. Make the requested code changes in the workspace and report what changed.",
			guidance: opts.guidance,
			output: opts.output,
			isolation: "worktree",
		});
		return markImplementationLineage(createStepResult("implement", result));
	};

	const analyze = async <TSchemaDef extends TSchema | undefined = undefined>(
		prompt: unknown,
		helpOpts: unknown = {},
	): Promise<SemanticStepResult<unknown>> => {
		const taskPrompt = requireString(prompt, "analyze prompt");
		const opts = normalizeSemanticStepOptions<TSchemaDef>(helpOpts);
		const result = await runSemanticAgent("analyze", taskPrompt, {
			label: opts.label,
			role: opts.role,
			model: opts.model,
			defaultRole: "planner",
			fallbackInstructions:
				"Act as a careful planner. Analyze the task, gather only the needed information, and produce a concise plan without making code changes.",
			guidance: opts.guidance,
			output: opts.output,
		});
		return createStepResult("analyze", result);
	};

	const reviewChange = async <TSchemaDef extends TSchema | undefined = undefined>(
		input: unknown,
		helpOpts: unknown = {},
	): Promise<SemanticStepResult<unknown>> => {
		const opts = normalizeSemanticStepOptions<TSchemaDef>(helpOpts);
		const promptParts = ["Review the following implementation result.", asPromptContext(input)];
		if (opts.guidance) promptParts.push(`Review guidance:\n${opts.guidance}`);
		const result = await runSemanticAgent("reviewChange", promptParts.join("\n\n"), {
			label: opts.label,
			role: opts.role,
			model: opts.model,
			defaultRole: "reviewer",
			fallbackInstructions:
				"Act as a careful reviewer. Inspect the implementation result for correctness, completeness, and test coverage gaps. If you report any blocking issue, status must be needs_fix. Only use approved when issues is empty.",
			guidance: joinInstructions(
				"If status is approved, issues must be empty. If issues contains any blocking item, status must be needs_fix.",
				opts.guidance,
			),
			output: opts.output ?? defaultReviewSchema(),
			isolation: hasImplementationLineage(input) ? "worktree" : undefined,
		});
		return createStepResult("reviewChange", normalizeReviewResult(result));
	};

	const continueImplementation = async <TSchemaDef extends TSchema | undefined = undefined>(
		previous: unknown,
		helpOpts: unknown,
	): Promise<SemanticStepResult<unknown>> => {
		const opts = normalizeContinueImplementationOptions<TSchemaDef>(helpOpts);
		const promptParts = [
			"Continue the previous implementation.",
			`Previous implementation result:\n${asPromptContext(previous)}`,
			`Feedback:\n${asPromptContext(opts.feedback)}`,
		];
		if (opts.guidance) promptParts.push(`Additional guidance:\n${opts.guidance}`);
		const result = await runSemanticAgent("continueImplementation", promptParts.join("\n\n"), {
			label: opts.label,
			role: opts.role,
			model: opts.model,
			defaultRole: "developer",
			fallbackInstructions:
				"Act as a careful developer continuing the same implementation path. Apply the feedback while preserving prior intent unless the feedback requires changes.",
			guidance: opts.guidance,
			output: opts.output,
			isolation: "worktree",
		});
		return markImplementationLineage(createStepResult("continueImplementation", result));
	};

	const testChange = async <TSchemaDef extends TSchema | undefined = undefined>(
		input: unknown,
		helpOpts: unknown = {},
	): Promise<SemanticStepResult<unknown>> => {
		const opts = normalizeSemanticStepOptions<TSchemaDef>(helpOpts);
		const promptParts = ["Validate the following implementation result.", asPromptContext(input)];
		if (opts.guidance) promptParts.push(`Validation guidance:\n${opts.guidance}`);
		const result = await runSemanticAgent("testChange", promptParts.join("\n\n"), {
			label: opts.label,
			role: opts.role,
			model: opts.model,
			defaultRole: "tester",
			fallbackInstructions:
				"Act as a careful tester. Validate the implementation with focused checks and report pass/fail clearly. In structured validation output, issues are blocking failures only; put non-blocking notes in warnings.",
			guidance: joinInstructions(
				"In structured validation output, use status passed only when there are no blocking issues. The issues array is for blocking validation failures only; put non-blocking observations, environment notes, or retry notes in warnings.",
				opts.guidance,
			),
			output: opts.output,
			isolation: hasImplementationLineage(input) ? "worktree" : undefined,
		});
		return createStepResult("testChange", normalizeValidationResult(result));
	};

	const pipeline = async (
		items: unknown[],
		...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
	) => {
		throwIfAborted();
		if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
		if (stages.some((stage) => typeof stage !== "function")) {
			throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
		}
		return Promise.all(
			items.map(async (item, index) => {
				let value: unknown = item;
				for (const stage of stages) {
					try {
						throwIfAborted();
						value = await stage(value, item, index);
						throwIfAborted();
					} catch (error) {
						if (options.signal?.aborted) throw error;
						log(`pipeline[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
						return null;
					}
				}
				return value;
			}),
		);
	};

	const context = vm.createContext({
		agent,
		analyze,
		implement,
		reviewChange,
		continueImplementation,
		testChange,
		parallel,
		pipeline,
		log,
		phase,
		request_human: requestHuman,
		args: options.args,
		cwd: options.cwd ?? process.cwd(),
		process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
		budget,
		console: {
			log,
			info: log,
			warn: (m: unknown) => log(`[warn] ${String(m)}`),
			error: (m: unknown) => log(`[error] ${String(m)}`),
		},
		JSON,
		Math,
		Array,
		Object,
		String,
		Number,
		Boolean,
		Set,
		Map,
		Promise,
	});

	const wrapped = `(async () => {\n${body}\n})()`;
	// Validate syntax before executing
	try {
		new vm.Script(wrapped, { filename: `${meta.name || "workflow"}.js` });
	} catch (error) {
		throw new Error(`Workflow script syntax error: ${error instanceof Error ? error.message : String(error)}`);
	}
	const result = await new vm.Script(wrapped, { filename: `${meta.name || "workflow"}.js` }).runInContext(context);
	await Promise.allSettled([...pendingAgentRuns]);
	assertStructuredCloneable(result, "workflow result");
	return {
		meta,
		result: result as T,
		logs: state.logs,
		phases: state.phases,
		agentCount: state.agentCount,
		durationMs: Date.now() - started,
		usage: workflowUsage,
	};
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
	const ast = parseWorkflowAst(script);

	assertDeterministicAst(ast);

	const first = ast.body?.[0] as AnyNode | undefined;
	if (first?.type !== "ExportNamedDeclaration") {
		throw new Error("`export const meta = { name, description, phases }` must be the first statement in the script");
	}

	const declaration = first.declaration as AnyNode | null;
	if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
		throw new Error("meta export must be `export const meta = ...`");
	}
	const declarations = declaration.declarations;
	if (!declarations || declarations.length !== 1) {
		throw new Error("meta export must declare only `meta`");
	}

	const declarator = declarations[0] as AnyNode;
	if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
		throw new Error("meta export must declare `meta`");
	}
	if (!declarator.init) throw new Error("meta must have a literal value");

	const meta = evaluateLiteral(declarator.init, "meta");
	validateMeta(meta);

	return {
		meta,
		body: script.slice(0, first.start) + script.slice(first.end),
	};
}

export function validateSemanticWorkflowScript(script: string): void {
	const { body } = parseWorkflowScript(script);
	if (!body.trim()) return;

	const ast = parseWorkflowAst(body);
	const errors: string[] = [];

	const visit = (node: AnyNode) => {
		if (node.type === "CallExpression") {
			const calleeName = identifierNameOf(node.callee as AnyNode | undefined);
			if (calleeName === "agent" || calleeName === "pipeline") {
				errors.push(
					`raw ${calleeName}() is not allowed in semantic workflows; use analyze(), implement(), reviewChange(), continueImplementation(), or testChange() instead`,
				);
			}
			if (calleeName && SEMANTIC_WORKFLOW_HELPERS.has(calleeName)) {
				const optsArg = (node.arguments as AnyNode[] | undefined)?.[1];
				if (optsArg?.type === "ObjectExpression") {
					for (const prop of optsArg.properties as AnyNode[]) {
						if (prop.type !== "Property") continue;
						const keyName = propertyNameOfKeyNode(prop.key as AnyNode | undefined);
						if (keyName && FORBIDDEN_SEMANTIC_CONTROL_KEYS.has(keyName)) {
							errors.push(`low-level control key "${keyName}" is not allowed in ${calleeName}() options`);
						}
					}
				}
			}
		}

		if (node.type === "MemberExpression") {
			const objectName = identifierNameOf(node.object as AnyNode | undefined);
			const propertyName = propertyNameOf(node);
			if (objectName === "args" && propertyName && FORBIDDEN_GENERATED_ITERATE_ARGS.has(propertyName)) {
				errors.push(`reading args.${propertyName} is not allowed; iterate workflows are managed by the system`);
			}
		}

		for (const child of astChildren(node)) visit(child);
	};

	visit(ast);

	if (errors.length > 0) {
		throw new Error(`Semantic workflow validation failed:\n${errors.join("\n")}`);
	}
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
	switch (node.type) {
		case "ObjectExpression": {
			const out: Record<string, unknown> = {};
			for (const prop of node.properties as AnyNode[]) {
				if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
				if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
				if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
				if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
				const key = propertyKey(prop.key as AnyNode, path);
				if (key === "__proto__" || key === "constructor" || key === "prototype") {
					throw new Error(`reserved key name not allowed in ${path}: ${key}`);
				}
				out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
			}
			return out;
		}
		case "ArrayExpression":
			return (node.elements as Array<AnyNode | null>).map((element, index) => {
				if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
				if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
				return evaluateLiteral(element, `${path}[${index}]`);
			});
		case "Literal":
			return node.value;
		case "TemplateLiteral":
			if ((node.expressions?.length ?? 0) > 0) throw new Error(`template interpolation not allowed in ${path}`);
			return (node.quasis ?? [])
				.map((quasi: AnyNode) => {
					const value = quasi.value as TemplateElementValue;
					return value.cooked ?? value.raw;
				})
				.join("");
		case "UnaryExpression":
			if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
				return -node.argument.value;
			}
			throw new Error(`only negative-number unary allowed in ${path}`);
		default:
			throw new Error(`non-literal node type in ${path}: ${node.type}`);
	}
}

function parseWorkflowAst(script: string): AnyNode {
	return parse(script, {
		ecmaVersion: "latest",
		sourceType: "module",
		allowAwaitOutsideFunction: true,
		allowReturnOutsideFunction: true,
		ranges: false,
	}) as unknown as AnyNode;
}

function propertyKey(node: AnyNode, path: string): string {
	if (node.type === "Identifier" && node.name) return node.name;
	if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) {
		return String(node.value);
	}
	throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
	if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
	const value = meta as WorkflowMeta;
	if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
	if (typeof value.description !== "string" || !value.description.trim()) {
		throw new Error("meta.description must be a non-empty string");
	}
	if (value.whenToUse !== undefined && typeof value.whenToUse !== "string") {
		throw new Error("meta.whenToUse must be a string");
	}
	if (value.phases !== undefined) {
		if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
		for (const phase of value.phases) {
			if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
				throw new Error("each meta phase must have a title string");
			}
		}
	}
}

function assertDeterministicAst(node: AnyNode): void {
	if (isDateNowCall(node) || isMathRandomCall(node) || isNewDateExpression(node)) {
		throw new Error(NONDETERMINISM_ERROR);
	}
	for (const child of astChildren(node)) assertDeterministicAst(child);
}

function astChildren(node: AnyNode): AnyNode[] {
	const children: AnyNode[] = [];
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) children.push(...value.filter(isAstNode));
		else if (isAstNode(value)) children.push(value);
	}
	return children;
}

function isAstNode(value: unknown): value is AnyNode {
	return !!value && typeof value === "object" && typeof (value as AnyNode).type === "string";
}

function isDateNowCall(node: AnyNode): boolean {
	return node.type === "CallExpression" && isMemberExpression(node.callee as AnyNode | undefined, "Date", "now");
}

function isMathRandomCall(node: AnyNode): boolean {
	return node.type === "CallExpression" && isMemberExpression(node.callee as AnyNode | undefined, "Math", "random");
}

function isNewDateExpression(node: AnyNode): boolean {
	const callee = node.callee as AnyNode | undefined;
	return node.type === "NewExpression" && callee?.type === "Identifier" && callee.name === "Date";
}

function isMemberExpression(node: AnyNode | undefined, objectName: string, propertyName: string): boolean {
	const object = node?.object as AnyNode | undefined;
	if (node?.type !== "MemberExpression" || object?.type !== "Identifier" || object.name !== objectName) {
		return false;
	}
	return propertyNameOf(node) === propertyName;
}

function propertyNameOf(node: AnyNode): string | undefined {
	const property = node.property as AnyNode | undefined;
	if (!node.computed && property?.type === "Identifier") return property.name;
	return staticStringOf(property);
}

function identifierNameOf(node: AnyNode | undefined): string | undefined {
	return node?.type === "Identifier" ? node.name : undefined;
}

function propertyNameOfKeyNode(node: AnyNode | undefined): string | undefined {
	if (!node) return undefined;
	if (node.type === "Identifier") return node.name;
	return staticStringOf(node);
}

function staticStringOf(node: AnyNode | undefined): string | undefined {
	if (node?.type === "Literal" && typeof node.value === "string") return node.value;
	if (node?.type === "TemplateLiteral" && (node.expressions?.length ?? 0) === 0) {
		return (node.quasis ?? [])
			.map((quasi: AnyNode) => {
				const value = quasi.value as TemplateElementValue;
				return value.cooked ?? value.raw;
			})
			.join("");
	}
	if (node?.type === "BinaryExpression" && node.operator === "+") {
		const left = staticStringOf(node.left as AnyNode | undefined);
		const right = staticStringOf(node.right as AnyNode | undefined);
		if (left !== undefined && right !== undefined) return left + right;
	}
	return undefined;
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
	return value;
}

function optionalString(value: unknown, name: string): string | undefined {
	if (value === undefined) return undefined;
	return requireString(value, name);
}

function normalizeAgentOptions(value: unknown): AgentOptions {
	if (!value || typeof value !== "object") throw new TypeError("agent options must be an object");
	const options = value as AgentOptions;
	if (options.isolation !== undefined && options.isolation !== "worktree") {
		throw new TypeError("agent isolation must be 'worktree'");
	}
	return {
		...options,
		label: optionalString(options.label, "agent label"),
		phase: optionalString(options.phase, "agent phase"),
		role: optionalString(options.role, "agent role"),
		model: optionalString(options.model, "agent model"),
		instructions: optionalString(options.instructions, "agent instructions"),
		reuseBranch: optionalString(options.reuseBranch, "agent reuseBranch"),
		agentType: optionalString(options.agentType, "agent type"),
	};
}

function normalizeSemanticStepOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined>(
	value: unknown,
): { role?: string; model?: string; guidance?: string; output?: TSchemaDef; label?: string } {
	if (value === undefined) return {};
	if (!value || typeof value !== "object") throw new TypeError("semantic step options must be an object");
	const options = value as Record<string, unknown>;
	const allowed = new Set(["role", "model", "guidance", "output", "label"]);
	for (const key of Object.keys(options)) {
		if (!allowed.has(key)) {
			throw new TypeError(`unsupported semantic step option: ${key}`);
		}
	}
	return {
		role: optionalString(options.role, "step role"),
		model: optionalString(options.model, "step model"),
		guidance: optionalString(options.guidance, "step guidance"),
		output: options.output as TSchemaDef | undefined,
		label: optionalString(options.label, "step label"),
	};
}

function normalizeContinueImplementationOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined>(
	value: unknown,
): { role?: string; model?: string; guidance?: string; output?: TSchemaDef; label?: string; feedback: unknown } {
	if (!value || typeof value !== "object") {
		throw new TypeError("continueImplementation options must be an object with feedback");
	}
	const options = value as Record<string, unknown>;
	const allowed = new Set(["role", "model", "guidance", "output", "label", "feedback"]);
	for (const key of Object.keys(options)) {
		if (!allowed.has(key)) {
			throw new TypeError(`unsupported continueImplementation option: ${key}`);
		}
	}
	if (!("feedback" in options)) throw new TypeError("continueImplementation feedback is required");
	return {
		role: optionalString(options.role, "step role"),
		model: optionalString(options.model, "step model"),
		guidance: optionalString(options.guidance, "step guidance"),
		output: options.output as TSchemaDef | undefined,
		label: optionalString(options.label, "step label"),
		feedback: options.feedback,
	};
}

function normalizeReviewResult(result: unknown): unknown {
	if (!result || typeof result !== "object" || Array.isArray(result)) return result;
	const review = result as Record<string, unknown>;
	const issues = Array.isArray(review.issues)
		? review.issues.filter((issue) => typeof issue === "string" && issue.trim().length > 0)
		: [];
	if (review.status === "approved" && issues.length > 0) {
		return {
			...review,
			status: "needs_fix",
			summary:
				typeof review.summary === "string" && review.summary.trim()
					? `${review.summary}\n\nRuntime note: review reported issues, so approved was treated as needs_fix.`
					: "Review reported issues, so approved was treated as needs_fix.",
		};
	}
	return result;
}

function normalizeValidationResult(result: unknown): unknown {
	if (!result || typeof result !== "object" || Array.isArray(result)) return result;
	const validation = result as Record<string, unknown>;
	const issues = Array.isArray(validation.issues)
		? validation.issues.filter((issue) => typeof issue === "string" && issue.trim().length > 0)
		: [];
	if (validation.status === "passed" && issues.length > 0) {
		return {
			...validation,
			status: "failed",
			summary:
				typeof validation.summary === "string" && validation.summary.trim()
					? `${validation.summary}\n\nRuntime note: validation reported blocking issues, so passed was treated as failed. Put non-blocking notes in warnings instead of issues.`
					: "Validation reported blocking issues, so passed was treated as failed. Put non-blocking notes in warnings instead of issues.",
		};
	}
	return result;
}

function defaultReviewSchema(): TSchema {
	return {
		type: "object",
		properties: {
			status: { type: "string", enum: ["approved", "needs_fix"] },
			summary: { type: "string" },
			issues: { type: "array", items: { type: "string" } },
		},
		required: ["status", "summary"],
		additionalProperties: true,
	} as unknown as TSchema;
}

function assertStructuredCloneable(value: unknown, name: string): void {
	try {
		structuredClone(value);
	} catch (error) {
		const detail = error instanceof Error ? ` ${error.message}` : "";
		throw new Error(
			`${name} must be structured-cloneable; did you forget to await agent(), parallel(), or pipeline()?${detail}`,
		);
	}
}

function createAgentTimeoutSignal(
	parent: AbortSignal | undefined,
	timeoutMs: number | null | undefined,
	label: string,
): { signal?: AbortSignal; cleanup: () => void } {
	const ms = timeoutMs ?? 0;
	if (ms <= 0) return { signal: parent, cleanup: () => {} };
	const controller = new AbortController();
	let timedOut = false;
	const onParentAbort = () => controller.abort(parent?.reason);
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(new Error(`Agent ${label} timed out after ${ms}ms`));
	}, ms);
	parent?.addEventListener("abort", onParentAbort, { once: true });
	controller.signal.addEventListener(
		"abort",
		() => {
			if (timedOut) return;
			clearTimeout(timer);
		},
		{ once: true },
	);
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", onParentAbort);
		},
	};
}

function createLimiter(limit: number) {
	let active = 0;
	const queue: Array<() => void> = [];
	const next = () => {
		active--;
		queue.shift()?.();
	};
	return async <T>(fn: () => Promise<T>): Promise<T> => {
		if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
		active++;
		try {
			return await fn();
		} finally {
			next();
		}
	};
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
	return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

function buildAgentInstructions(phase: string | undefined, options: AgentOptions): string | undefined {
	const lines = [];
	if (phase) lines.push(`Workflow phase: ${phase}`);
	if (options.agentType) lines.push(`Act as workflow subagent type: ${options.agentType}`);
	if (options.isolation) lines.push(`Requested isolation: ${options.isolation}`);
	if (options.model) lines.push(`Requested model: ${options.model}`);
	if (options.instructions) lines.push(options.instructions);
	return lines.length ? lines.join("\n") : undefined;
}

function estimateTokens(value: unknown): number {
	return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

function dumpArtifact(options: WorkflowRunOptions, state: RuntimeState, label: string, result: unknown): void {
	if (!options.dumpArtifacts || !options.runDir) return;
	const dir = join(options.runDir, "debug", "artifacts");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const seq = String(++state.artifactSeq).padStart(2, "0");
	const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_");
	writeFileSync(join(dir, `${seq}-${safeLabel}.json`), JSON.stringify(result, null, 2));
}
