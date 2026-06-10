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
import { createStructuredOutputTool, resolveModelSpec } from "../../src/workflow-engine/index.ts";
import { parseWorkflowScript } from "../../src/workflow-engine/runtime.ts";

const SCRIPT_SCHEMA = {
	type: "object",
	properties: { script: { type: "string" } },
	required: ["script"],
	additionalProperties: false,
} as const;

export class PromptAuthor {
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
			await session.prompt(prompt);
			let script = selectValidScript(capture.value?.script, session.messages ?? []);
			if (!script) {
				await session.prompt(
					[
						"Your previous response did not return a complete valid raw JavaScript workflow.",
						"Reply again with ONLY the complete JavaScript workflow.",
						"Requirements:",
						"- include export const meta = { name, description } as the first statement",
						"- return complete syntactically valid JavaScript",
						"- no markdown fences, no JSON wrapper, no commentary",
					].join("\n"),
				);
				script = selectValidScript(capture.value?.script, session.messages ?? []);
			}
			if (!script) {
				const recent = (session.messages ?? [])
					.slice(-4)
					.map((m: unknown) => JSON.stringify(m))
					.join(" | ");
				throw new Error(`Prompt author did not produce a valid script. recent=${recent.slice(0, 1000)}`);
			}
			return script;
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

function selectValidScript(capturedScript: string | undefined, messages: unknown[]): string | undefined {
	if (isValidWorkflowScript(capturedScript)) return capturedScript;
	const extracted = extractScript(messages);
	if (isValidWorkflowScript(extracted)) return extracted;
	return capturedScript ?? extracted;
}

function isValidWorkflowScript(script: string | undefined): script is string {
	if (!script?.trim()) return false;
	try {
		parseWorkflowScript(script);
		return true;
	} catch {
		return false;
	}
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
