import { join } from "node:path";
import {
	AuthStorage,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	createAgentSession,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { createStructuredOutputTool } from "../workflow-engine/index.ts";
import { buildWorkflowAuthorPrompt } from "../workflow-engine/prompt-guidelines.ts";

export interface WorkflowAuthor {
	generate(prompt: string): Promise<string>;
}

/** Stub used in tests and when no LLM is configured. Wraps the raw prompt as a minimal valid script. */
export class StubWorkflowAuthor implements WorkflowAuthor {
	async generate(prompt: string): Promise<string> {
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
		} = {},
	) {}

	async generate(prompt: string): Promise<string> {
		const agentDir = this.opts.agentDir ?? getAgentDir();
		const authStorage = AuthStorage.create(this.opts.authPath ?? join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, this.opts.modelsPath ?? join(agentDir, "models.json"));
		const settingsManager = SettingsManager.inMemory();

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
			sessionManager: SessionManager.inMemory(),
			customTools: [outputTool as never],
			settingsManager,
			...(this.opts.model
				? {
						model: this.resolveModel(modelRegistry) as never,
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

	private resolveModel(modelRegistry: ModelRegistry): unknown {
		if (!this.opts.model) return undefined;

		// Support provider/model or provider:model format
		const colon = this.opts.model.indexOf(":");
		const slash = this.opts.model.indexOf("/");
		const sep = colon > 0 ? colon : slash > 0 ? slash : -1;

		if (sep > 0) {
			const provider = this.opts.model.slice(0, sep);
			const modelId = this.opts.model.slice(sep + 1);
			const found = modelRegistry.find(provider, modelId);
			if (found) return found;
		}

		// Fallback: search by id or name
		return modelRegistry.getAll().find((m) => m.id === this.opts.model || m.name === this.opts.model);
	}
}
