// Portions of this file are derived from pi-dynamic-workflows
// (https://github.com/Michaelliv/pi-dynamic-workflows), MIT licensed.

import vm from "node:vm";
import { SpanStatusCode, type Tracer } from "@opentelemetry/api";
import type { Node } from "acorn";
import { parse } from "acorn";
import type { TSchema } from "typebox";
import type { HumanRequest, HumanResponse } from "../human/index.ts";
import type { IsolationManager } from "../isolation/index.ts";
import { hashHumanRequest } from "../journal/index.ts";
import * as Attrs from "../tracing/attributes.ts";
import { WorkflowAgent, type WorkflowAgentOptions } from "./workflow-agent.ts";

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

export interface WorkflowRunOptions extends Omit<WorkflowAgentOptions, "journal"> {
	args?: unknown;
	taskId?: string;
	model?: string;
	agent?: Pick<WorkflowAgent, "run">;
	journal?: WorkflowJournal;
	agentJournal?: WorkflowAgentOptions["journal"];
	isolationManager?: Pick<IsolationManager, "prepare">;
	human?: WorkflowHumanGate;
	concurrency?: number;
	tokenBudget?: number | null;
	signal?: AbortSignal;
	tracer?: Tracer;
	onLog?: (message: string) => void;
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

export interface WorkflowRunResult<T = unknown> {
	meta: WorkflowMeta;
	result: T;
	logs: string[];
	phases: string[];
	agentCount: number;
	durationMs: number;
}

export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
	label?: string;
	phase?: string;
	schema?: TSchemaDef;
	role?: string;
	model?: string;
	instructions?: string;
	isolation?: "worktree";
	agentType?: string;
}

interface RuntimeState {
	currentPhase?: string;
	logs: string[];
	phases: string[];
	agentCount: number;
	humanCount: number;
	spent: number;
}

type AnyNode = Node & {
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

const DETERMINISM_BLOCKLIST = /\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(\s*\)/;

export async function runWorkflow<T = unknown>(
	script: string,
	options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
	const started = Date.now();
	const { meta, body } = parseWorkflowScript(script);
	const state: RuntimeState = { logs: [], phases: [], agentCount: 0, humanCount: 0, spent: 0 };
	const agentRunner =
		options.agent ??
		new WorkflowAgent({
			...options,
			journal: options.agentJournal,
			isolationManager: options.isolationManager,
			taskId: options.taskId,
		});
	const concurrency = Math.max(
		1,
		Math.min(options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2), 16),
	);
	const limiter = createLimiter(concurrency);

	const log = (message: string) => {
		const text = String(message);
		state.logs.push(text);
		options.onLog?.(text);
	};

	const phase = (title: string) => {
		state.currentPhase = title;
		if (!state.phases.includes(title)) state.phases.push(title);
		options.onPhase?.(title);
		options.tracer
			?.startSpan("workflow.phase", {
				attributes: {
					[Attrs.PHASE_NAME]: title,
					[Attrs.TASK_ID]: options.taskId ?? "",
				},
			})
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

	const agent = async (prompt: string, agentOptions: AgentOptions = {}) => {
		throwIfAborted();
		if (budget.total !== null && budget.remaining() <= 0) throw new Error("workflow token budget exhausted");
		const assignedPhase = agentOptions.phase ?? state.currentPhase;
		const requestedLabel = agentOptions.label?.trim();
		return limiter(async () => {
			state.agentCount++;
			const label = requestedLabel || defaultAgentLabel(assignedPhase, state.agentCount);
			const agentSpan = options.tracer?.startSpan("workflow.agent", {
				attributes: {
					[Attrs.AGENT_LABEL]: label,
					[Attrs.AGENT_ROLE]: agentOptions.role ?? "",
					[Attrs.AGENT_MODEL]: agentOptions.model ?? "",
					[Attrs.PHASE_NAME]: assignedPhase ?? "",
					[Attrs.TASK_ID]: options.taskId ?? "",
				},
			});
			options.onAgentStart?.({ label, phase: assignedPhase, prompt });
			try {
				throwIfAborted();
				const result = await agentRunner.run(prompt, {
					label,
					role: agentOptions.role,
					model: agentOptions.model,
					schema: agentOptions.schema,
					signal: options.signal,
					instructions: buildAgentInstructions(assignedPhase, agentOptions),
				});
				throwIfAborted();
				state.spent += estimateTokens(result);
				agentSpan?.setStatus({ code: SpanStatusCode.OK });
				options.onAgentEnd?.({ label, phase: assignedPhase, result });
				return result;
			} catch (error) {
				if (options.signal?.aborted) throw error;
				agentSpan?.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
				if (error instanceof Error) agentSpan?.recordException(error);
				log(`agent ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
				options.onAgentEnd?.({ label, phase: assignedPhase, result: null });
				return null;
			} finally {
				agentSpan?.end();
			}
		});
	};

	const parallel = async (thunks: Array<() => Promise<unknown>>) => {
		throwIfAborted();
		if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
		if (thunks.some((thunk) => typeof thunk !== "function")) {
			throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
		}
		return Promise.all(
			thunks.map(async (thunk, index) => {
				try {
					return await thunk();
				} catch (error) {
					if (options.signal?.aborted) throw error;
					log(`parallel[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
					return null;
				}
			}),
		);
	};

	const requestHuman = async (request: HumanRequest): Promise<HumanResponse> => {
		throwIfAborted();
		if (!options.human) throw new Error("request_human() is not configured for this workflow run");

		const ordinal = state.humanCount++;
		const cacheKey = hashHumanRequest(request, ordinal);
		const cached = options.journal?.lookupHuman<HumanResponse>(cacheKey);
		if (cached) return cached.response;

		const requestId = `${options.taskId ?? "workflow"}_${ordinal}`;
		const humanSpan = options.tracer?.startSpan("human.request", {
			attributes: {
				[Attrs.HUMAN_REQUEST_ID]: requestId,
				[Attrs.TASK_ID]: options.taskId ?? "",
				"human.title": request.title ?? "",
			},
		});
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
	const result = await new vm.Script(wrapped, { filename: `${meta.name || "workflow"}.js` }).runInContext(context);
	return {
		meta,
		result: result as T,
		logs: state.logs,
		phases: state.phases,
		agentCount: state.agentCount,
		durationMs: Date.now() - started,
	};
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
	if (DETERMINISM_BLOCKLIST.test(script)) {
		throw new Error("Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable");
	}

	const ast = parse(script, {
		ecmaVersion: "latest",
		sourceType: "module",
		allowAwaitOutsideFunction: true,
		allowReturnOutsideFunction: true,
		ranges: false,
	}) as unknown as AnyNode;

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
