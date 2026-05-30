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
			sessionManager: SessionManager.inMemory(),
			customTools: [outputTool as never],
			settingsManager,
			...(this.opts.model
				? {
						model: modelRegistry.getAll().find((m) => m.id === this.opts.model || m.name === this.opts.model) as never,
					}
				: {}),
		});

		try {
			await session.prompt(buildWorkflowAuthorPrompt(prompt));
			if (!capture.called || !capture.value?.script) {
				throw new Error("Workflow author did not produce a script");
			}
			return capture.value.script;
		} finally {
			session.dispose();
		}
	}
}
