import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
import { createStructuredOutputTool, resolveModelSpec } from "../workflow-engine/index.ts";
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
		const settingsManager = SettingsManager.create(process.cwd(), agentDir);
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
						model: resolveModelSpec(requestedModel, {
							modelRegistry,
							defaultProvider: settingsManager.getDefaultProvider() ?? readDefaultProvider(agentDir),
						}) as never,
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
}

function readDefaultProvider(agentDir: string): string | undefined {
	try {
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as { defaultProvider?: unknown };
		return typeof settings.defaultProvider === "string" && settings.defaultProvider.trim()
			? settings.defaultProvider
			: undefined;
	} catch {
		return undefined;
	}
}
