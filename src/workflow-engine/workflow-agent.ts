// Portions of this file are derived from pi-dynamic-workflows
// (https://github.com/Michaelliv/pi-dynamic-workflows), MIT licensed.

import { join } from "node:path";
import {
	AuthStorage,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
	createAgentSession,
	createCodingTools,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { hashCall } from "../journal/index.ts";
import { type RoleConfig, buildSubagentPrompt, filterToolsByWhitelist, loadRole } from "../roles/index.ts";
import { type StructuredOutputCapture, createStructuredOutputTool } from "./structured-output.ts";

interface AssistantTextMessage {
	role?: string;
	content?: Array<{ type?: string; text?: string }>;
}

export type PiModel = NonNullable<CreateAgentSessionOptions["model"]>;
export type CreateSession = (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
export type CreateCodingTools = (cwd: string) => ToolDefinition[];
export type ModelResolver = (
	modelName: string,
	context: { modelRegistry?: CreateAgentSessionOptions["modelRegistry"] },
) => PiModel | undefined | Promise<PiModel | undefined>;

export interface AgentJournal {
	lookup<T = unknown>(cacheKey: string): { result: T; tokens: number | null } | null;
	write<T = unknown>(cacheKey: string, input: { result: T; tokens?: number | null }): void;
}

export interface WorkflowAgentOptions {
	cwd?: string;
	/** Extra tools available to the subagent in addition to the structured output tool. */
	tools?: ToolDefinition[];
	/** Override any createAgentSession option (model, authStorage, resourceLoader, etc.). */
	session?: Partial<CreateAgentSessionOptions>;
	/** Extra system guidance prepended to every subagent task. */
	instructions?: string;
	rolesDir?: string;
	loadRole?: (name: string) => RoleConfig | Promise<RoleConfig>;
	createSession?: CreateSession;
	createCodingTools?: CreateCodingTools;
	resolveModel?: ModelResolver;
	agentDir?: string;
	authPath?: string;
	modelsPath?: string;
	inheritPiSettings?: boolean;
	disableSubagentCompaction?: boolean;
	journal?: AgentJournal;
}

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
	label?: string;
	schema?: TSchemaDef;
	tools?: ToolDefinition[];
	role?: string;
	model?: string;
	instructions?: string;
	signal?: AbortSignal;
}

export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema
	? Static<TSchemaDef>
	: string;

export class WorkflowAgent {
	private readonly cwd: string;
	private readonly baseTools: ToolDefinition[];
	private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
	private readonly instructions?: string;
	private readonly rolesDir?: string;
	private readonly roleLoader?: (name: string) => RoleConfig | Promise<RoleConfig>;
	private readonly createSession: CreateSession;
	private readonly modelResolver: ModelResolver;
	private readonly agentDir: string;
	private readonly authPath?: string;
	private readonly modelsPath?: string;
	private readonly inheritPiSettings: boolean;
	private readonly disableSubagentCompaction: boolean;
	private readonly journal?: AgentJournal;

	constructor(options: WorkflowAgentOptions = {}) {
		this.cwd = options.cwd ?? process.cwd();
		this.baseTools = options.tools ?? (options.createCodingTools ?? createCodingTools)(this.cwd);
		this.sessionOptions = options.session ?? {};
		this.instructions = options.instructions;
		this.rolesDir = options.rolesDir;
		this.roleLoader = options.loadRole;
		this.createSession = options.createSession ?? createAgentSession;
		this.modelResolver = options.resolveModel ?? resolveModelSpec;
		this.agentDir = options.agentDir ?? getAgentDir();
		this.authPath = options.authPath;
		this.modelsPath = options.modelsPath;
		this.inheritPiSettings = options.inheritPiSettings ?? true;
		this.disableSubagentCompaction = options.disableSubagentCompaction ?? true;
		this.journal = options.journal;
	}

	async run<TSchemaDef extends TSchema | undefined = undefined>(
		prompt: string,
		options: AgentRunOptions<TSchemaDef> = {},
	): Promise<AgentRunResult<TSchemaDef>> {
		const roleConfig = options.role ? await this.loadRole(options.role) : null;
		const schema = options.schema ?? (roleConfig?.defaultSchema as TSchema | undefined);
		const capture: StructuredOutputCapture<Static<Extract<TSchemaDef, TSchema>>> = {
			called: false,
			value: undefined,
		};
		const baseTools = roleConfig ? filterToolsByWhitelist(this.baseTools, roleConfig.tools.allow) : this.baseTools;
		const customTools: ToolDefinition[] = [...baseTools, ...(options.tools ?? [])];

		if (schema) {
			customTools.push(createStructuredOutputTool({ schema, capture }) as unknown as ToolDefinition);
		}

		const requestedModel = options.model ?? roleConfig?.defaultModel;
		const additionalInstructions = this.buildAdditionalInstructions(options.instructions);
		const cacheKey = hashCall({
			prompt,
			role: options.role,
			schema,
			model: requestedModel,
			instructions: additionalInstructions,
			cwd: this.cwd,
		});
		const cached = this.journal?.lookup<AgentRunResult<TSchemaDef>>(cacheKey);
		if (cached) return cached.result;

		const sessionOptions = await this.buildSessionOptions(requestedModel);

		const { session } = await this.createSession({
			cwd: this.cwd,
			agentDir: this.agentDir,
			sessionManager: SessionManager.inMemory(),
			customTools,
			...sessionOptions,
		});

		let removeAbortListener: (() => void) | undefined;
		try {
			if (options.signal?.aborted) throw new Error("Subagent was aborted");
			if (options.signal) {
				const onAbort = () => void session.abort();
				options.signal.addEventListener("abort", onAbort, { once: true });
				removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
			}

			await session.prompt(this.buildPrompt(prompt, options, roleConfig, Boolean(schema), additionalInstructions));
			if (options.signal?.aborted) throw new Error("Subagent was aborted");

			let result: AgentRunResult<TSchemaDef>;
			if (schema) {
				if (!capture.called) {
					throw new Error("Subagent finished without calling structured_output");
				}
				result = capture.value as AgentRunResult<TSchemaDef>;
			} else {
				result = this.lastAssistantText(session.messages) as AgentRunResult<TSchemaDef>;
			}

			this.journal?.write(cacheKey, { result, tokens: estimateTokens(result) });
			return result;
		} finally {
			removeAbortListener?.();
			session.dispose();
		}
	}

	private async loadRole(name: string): Promise<RoleConfig> {
		if (this.roleLoader) return this.roleLoader(name);
		if (!this.rolesDir) throw new Error(`Role requested but rolesDir is not configured: ${name}`);
		return loadRole(name, { rolesDir: this.rolesDir });
	}

	private async buildSessionOptions(modelName: string | undefined): Promise<Partial<CreateAgentSessionOptions>> {
		const authStorage =
			this.sessionOptions.authStorage ?? AuthStorage.create(this.authPath ?? join(this.agentDir, "auth.json"));
		const modelRegistry =
			this.sessionOptions.modelRegistry ??
			ModelRegistry.create(authStorage, this.modelsPath ?? join(this.agentDir, "models.json"));
		const settingsManager = this.sessionOptions.settingsManager ?? this.createSettingsManager();

		if (!modelName) {
			return { ...this.sessionOptions, authStorage, modelRegistry, settingsManager };
		}

		const model = await this.modelResolver(modelName, { modelRegistry });
		if (!model) throw new Error(`Model not found: ${modelName}`);

		return {
			...this.sessionOptions,
			authStorage,
			modelRegistry,
			settingsManager,
			model,
		};
	}

	private createSettingsManager(): SettingsManager {
		const settingsManager = this.inheritPiSettings
			? SettingsManager.create(this.cwd, this.agentDir)
			: SettingsManager.inMemory();
		if (this.disableSubagentCompaction) {
			settingsManager.applyOverrides({ compaction: { enabled: false } });
		}
		return settingsManager;
	}

	private buildAdditionalInstructions(callInstructions: string | undefined): string | undefined {
		return [this.instructions, callInstructions].filter(Boolean).join("\n") || undefined;
	}

	private buildPrompt<TSchemaDef extends TSchema | undefined>(
		prompt: string,
		options: AgentRunOptions<TSchemaDef>,
		roleConfig: RoleConfig | null,
		structured: boolean,
		additionalInstructions: string | undefined,
	): string {
		return buildSubagentPrompt({
			roleConfig,
			taskPrompt: prompt,
			label: options.label ?? "agent",
			hasSchema: structured,
			additionalInstructions,
		});
	}

	private lastAssistantText(messages: unknown[]): string {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i] as AssistantTextMessage | undefined;
			if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
			const text = message.content
				.filter((part) => part.type === "text" && typeof part.text === "string")
				.map((part) => part.text)
				.join("");
			if (text.trim()) return text;
		}
		return "";
	}
}

export function resolveModelSpec(
	modelName: string,
	context: { modelRegistry?: CreateAgentSessionOptions["modelRegistry"] } = {},
): PiModel | undefined {
	const modelRegistry = context.modelRegistry;
	if (!modelRegistry) return undefined;

	const explicit = parseExplicitModelSpec(modelName);
	if (explicit) {
		return modelRegistry.find(explicit.provider, explicit.modelId) as PiModel | undefined;
	}

	const matches = modelRegistry
		.getAll()
		.filter(
			(model) => model.id === modelName || model.name === modelName || `${model.provider}/${model.id}` === modelName,
		);
	return matches.length === 1 ? (matches[0] as PiModel) : undefined;
}

function estimateTokens(value: unknown): number {
	return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

function parseExplicitModelSpec(modelName: string): { provider: string; modelId: string } | undefined {
	const colon = modelName.indexOf(":");
	if (colon > 0 && colon < modelName.length - 1) {
		return { provider: modelName.slice(0, colon), modelId: modelName.slice(colon + 1) };
	}

	const slash = modelName.indexOf("/");
	if (slash > 0 && slash < modelName.length - 1) {
		return { provider: modelName.slice(0, slash), modelId: modelName.slice(slash + 1) };
	}

	return undefined;
}
