import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	AuthStorage,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	createAgentSession,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
	createStructuredOutputTool,
	parseWorkflowScript,
	resolveModelSpec,
	validateSemanticWorkflowScript,
} from "../workflow-engine/index.ts";
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

const MAX_GENERATION_ATTEMPTS = 3;

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
			noTools: "builtin",
			authStorage,
			modelRegistry,
			resourceLoader,
			sessionManager: this.opts.persistDir
				? (() => {
						if (!existsSync(this.opts.persistDir)) mkdirSync(this.opts.persistDir, { recursive: true });
						return SessionManager.create(process.cwd(), this.opts.persistDir);
					})()
				: SessionManager.inMemory(),
			customTools: [outputTool as never],
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
			let lastValidationError: string | undefined;
			for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
				capture.called = false;
				capture.value = undefined;
				const promptToUse =
					attempt === 1 ? buildWorkflowAuthorPrompt(prompt) : buildWorkflowRepairPrompt(lastValidationError, attempt);
				await session.prompt(promptToUse);
				const capturedScript = (capture.value as { script: string } | undefined)?.script;
				const selection = selectWorkflowScript(capturedScript, session.messages ?? []);
				if (selection.script) return selection.script;
				lastValidationError = selection.validationError;
			}
			throw new Error(
				buildWorkflowAuthorFailureMessage(MAX_GENERATION_ATTEMPTS, lastValidationError, session.messages ?? []),
			);
		} finally {
			session.dispose();
		}
	}
}

export function validateWorkflowScript(script: string | undefined): string | undefined {
	if (!script?.trim()) return "Workflow script is empty.";
	try {
		parseWorkflowScript(script);
		validateSemanticWorkflowScript(script);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export function selectWorkflowScript(
	capturedScript: string | undefined,
	messages: unknown[],
): { script?: string; validationError?: string } {
	const captured = capturedScript?.trim();
	if (captured) {
		const capturedError = validateWorkflowScript(captured);
		if (!capturedError) return { script: captured };
		const extractedScript = extractScript(messages);
		if (extractedScript) {
			const extractedError = validateWorkflowScript(extractedScript);
			if (!extractedError) return { script: extractedScript };
			return { validationError: extractedError };
		}
		return { validationError: capturedError };
	}
	const extractedScript = extractScript(messages);
	if (!extractedScript) return { validationError: "No valid workflow script candidate found." };
	const extractedError = validateWorkflowScript(extractedScript);
	if (!extractedError) return { script: extractedScript };
	return { validationError: extractedError };
}

function buildWorkflowRepairPrompt(lastError: string | undefined, attempt: number): string {
	return [
		`Attempt ${attempt}: your previous response did not return a complete valid JavaScript workflow.`,
		"Reply again with ONLY the complete JavaScript workflow, or call structured_output with a valid script.",
		"Requirements:",
		`- fix the previous validation error: ${lastError ?? "validation failure"}`,
		"- include export const meta = { name, description } as the first statement",
		"- return complete syntactically valid JavaScript",
		"- no markdown fences, no JSON wrapper, no commentary",
	].join("\n");
}

export function buildWorkflowAuthorFailureMessage(
	attempts: number,
	lastValidationError: string | undefined,
	messages: unknown[],
): string {
	const summary = summarizeRecentSessionMessages(messages);
	const errorInfo = lastValidationError ? ` Last validation error: ${lastValidationError}.` : "";
	return `Workflow author did not produce a valid script after ${attempts} attempts.${errorInfo} ${summary}`;
}

function extractScript(messages: unknown[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		const text = message.content
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (!text) continue;
		const fenced = text.match(/```(?:javascript|js)?\s*([\s\S]*?)```/i)?.[1]?.trim();
		if (fenced?.includes("export const meta")) return fenced;
		if (text.includes("export const meta")) return text;
	}
	return undefined;
}

function summarizeRecentSessionMessages(messages: unknown[]): string {
	const debugInfo = messages.slice(-3).map((m: unknown) => {
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
	return `msgs=${debugInfo.join(" | ")}`;
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
