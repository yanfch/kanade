import { existsSync, mkdirSync } from "node:fs";
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
import { parseWorkflowScript } from "../../src/workflow-engine/runtime.ts";

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
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir,
			settingsManager,
			noContextFiles: true,
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
			customTools: [],
			settingsManager,
			...(requestedModel
				? {
						model: resolveModel(modelRegistry, requestedModel) as never,
					}
				: {}),
		});

		try {
			await session.prompt(prompt);
			let script = extractScript(session.messages ?? []);
			if (!isValidWorkflowScript(script)) {
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
				script = extractScript(session.messages ?? []);
			}
			if (!isValidWorkflowScript(script)) {
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

function resolveModel(modelRegistry: ModelRegistry, modelName: string): unknown {
	const colon = modelName.indexOf(":");
	const slash = modelName.indexOf("/");
	const sep = colon > 0 ? colon : slash > 0 ? slash : -1;

	if (sep > 0) {
		const provider = modelName.slice(0, sep);
		const modelId = modelName.slice(sep + 1);
		const found = modelRegistry.find(provider, modelId);
		if (found) return found;
	}

	return modelRegistry.getAll().find((m) => m.id === modelName || m.name === modelName);
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
