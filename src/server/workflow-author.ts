import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	AuthStorage,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	createAgentSession,
	createReadOnlyTools,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { createStructuredOutputTool } from "../workflow-engine/index.ts";
import { buildWorkflowAuthorPrompt } from "../workflow-engine/prompt-guidelines.ts";

export interface WorkflowAuthor {
	generate(prompt: string, options?: { model?: string }): Promise<string>;
}

/** Stub used in tests and when no LLM is configured. Wraps the raw prompt as a minimal valid script. */
export class StubWorkflowAuthor implements WorkflowAuthor {
	async generate(prompt: string, _options?: { model?: string }): Promise<string> {
		// Produce a minimal valid script whose body is the raw prompt text.
		// This lets unit tests exercise the full create→run path without a real LLM.
		const body = prompt.trim().startsWith("return ") ? prompt.trim() : "return {}";
		return `export const meta = { name: 'generated', description: 'Generated workflow' }\n${body}`;
	}
}

const SCRIPT_SCHEMA = {
	type: "object",
	properties: { script: { type: "string" } },
	required: ["script"],
	additionalProperties: false,
} as const;

/** Real LLM-backed author using the pi SDK. */
export class LlmWorkflowAuthor implements WorkflowAuthor {
	constructor(
		private readonly opts: {
			agentDir?: string;
			authPath?: string;
			modelsPath?: string;
			model?: string;
			persistDir?: string;
		} = {},
	) {}

	async generate(prompt: string, options?: { model?: string }): Promise<string> {
		const agentDir = this.opts.agentDir ?? getAgentDir();
		const requestedModel = options?.model ?? this.opts.model;
		const authStorage = AuthStorage.create(this.opts.authPath ?? join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, this.opts.modelsPath ?? join(agentDir, "models.json"));
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir,
			settingsManager,
			noContextFiles: true,
		});

		const capture: { called: boolean; value: { script: string } | undefined } = {
			called: false,
			value: undefined,
		};

		const outputTool = createStructuredOutputTool({
			schema: SCRIPT_SCHEMA as unknown as TSchema,
			capture: capture as never,
		});

		const { session } = await createAgentSession({
			agentDir,
			authStorage,
			modelRegistry,
			resourceLoader,
			sessionManager: this.opts.persistDir
				? (() => {
						if (!existsSync(this.opts.persistDir)) mkdirSync(this.opts.persistDir, { recursive: true });
						return SessionManager.create(process.cwd(), this.opts.persistDir);
					})()
				: SessionManager.inMemory(),
			customTools: [...createReadOnlyTools(process.cwd()), outputTool as never],
			settingsManager,
			...(requestedModel
				? {
						model: this.resolveModel(modelRegistry, requestedModel) as never,
					}
				: {}),
		});

		try {
			await session.prompt(buildWorkflowAuthorPrompt(prompt));
			if (!capture.called || !capture.value?.script) {
				// Debug: log what the LLM actually returned
				const msgs = session.messages ?? [];
				const debugInfo = msgs.slice(-3).map((m: unknown) => {
					const msg = m as { role?: string; content?: unknown };
					const content = msg?.content;
					if (Array.isArray(content)) {
						return content
							.map((c: { type?: string; text?: string; thinking?: string }) => {
								if (c.type === "text") return `[text:${(c.text ?? "").slice(0, 100)}]`;
								if (c.type === "thinking") return `[thinking:${(c.thinking ?? "").slice(0, 100)}]`;
								return `[${c.type}]`;
							})
							.join(", ");
					}
					return String(content).slice(0, 100);
				});
				throw new Error(
					`Workflow author did not produce a script. called=${capture.called}, msgs=${debugInfo.join(" | ")}`,
				);
			}
			return capture.value.script;
		} finally {
			session.dispose();
		}
	}

	private resolveModel(modelRegistry: ModelRegistry, modelName: string): unknown {
		// Support provider/model or provider:model format
		const colon = modelName.indexOf(":");
		const slash = modelName.indexOf("/");
		const sep = colon > 0 ? colon : slash > 0 ? slash : -1;

		if (sep > 0) {
			const provider = modelName.slice(0, sep);
			const modelId = modelName.slice(sep + 1);
			const found = modelRegistry.find(provider, modelId);
			if (found) return found;
		}

		// Fallback: search by id or name
		return modelRegistry.getAll().find((m) => m.id === modelName || m.name === modelName);
	}
}
