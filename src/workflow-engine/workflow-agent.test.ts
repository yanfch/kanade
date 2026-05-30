import type {
	CreateAgentSessionOptions,
	CreateAgentSessionResult,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { RoleConfig } from "../roles/index.ts";
import {
	type AgentJournal,
	type CreateSession,
	type PiModel,
	WorkflowAgent,
	resolveModelSpec,
} from "./workflow-agent.ts";

function fakeTool(name: string): ToolDefinition {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	} as unknown as ToolDefinition;
}

function fakeRole(patch: Partial<RoleConfig> = {}): RoleConfig {
	return {
		name: "developer",
		dir: "/roles/developer",
		systemPrompt: "You implement minimal diffs.",
		tools: { allow: ["read"], extensions: [] },
		extensionPaths: [],
		...patch,
	};
}

function createMockJournal(): AgentJournal & {
	lookups: string[];
	writes: Array<{ cacheKey: string; input: { result: unknown; tokens?: number | null } }>;
	entries: Map<string, { result: unknown; tokens: number | null }>;
} {
	const entries = new Map<string, { result: unknown; tokens: number | null }>();
	const lookups: string[] = [];
	const writes: Array<{ cacheKey: string; input: { result: unknown; tokens?: number | null } }> = [];
	return {
		entries,
		lookups,
		writes,
		lookup<T = unknown>(cacheKey: string) {
			lookups.push(cacheKey);
			const entry = entries.get(cacheKey);
			return entry ? { result: entry.result as T, tokens: entry.tokens } : null;
		},
		write<T = unknown>(cacheKey: string, input: { result: T; tokens?: number | null }) {
			writes.push({ cacheKey, input });
			entries.set(cacheKey, { result: input.result, tokens: input.tokens ?? null });
		},
	};
}

function createMockSessionFactory(opts: { structuredResult?: unknown } = {}): {
	createSession: CreateSession;
	calls: CreateAgentSessionOptions[];
	prompts: string[];
	disposed: { value: boolean };
} {
	const calls: CreateAgentSessionOptions[] = [];
	const prompts: string[] = [];
	const disposed = { value: false };
	const createSession: CreateSession = async (options) => {
		calls.push(options);
		return {
			session: {
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "final text" }],
					},
				],
				async prompt(text: string) {
					prompts.push(text);
					if (opts.structuredResult !== undefined) {
						const tool = options.customTools?.find((item) => item.name === "structured_output");
						await tool?.execute("call-1", opts.structuredResult, undefined, undefined, undefined as never);
					}
				},
				async abort() {},
				dispose() {
					disposed.value = true;
				},
			},
		} as CreateAgentSessionResult;
	};
	return { createSession, calls, prompts, disposed };
}

describe("WorkflowAgent", () => {
	it("uses injected session and coding-tool factories", async () => {
		const mock = createMockSessionFactory();
		const agent = new WorkflowAgent({
			cwd: "/repo",
			createSession: mock.createSession,
			createCodingTools: (cwd) => [fakeTool(`read:${cwd}`)],
		});

		const result = await agent.run("Summarize", { label: "summary" });

		expect(result).toBe("final text");
		expect(mock.calls).toHaveLength(1);
		expect(mock.calls[0].cwd).toBe("/repo");
		expect(mock.calls[0].customTools?.map((tool) => tool.name)).toEqual(["read:/repo"]);
		expect(mock.prompts[0]).toContain("Task label: summary");
		expect(mock.prompts[0]).toContain("Summarize");
		expect(mock.disposed.value).toBe(true);
	});

	it("loads role config, filters tools, and builds role prompt", async () => {
		const schema = Type.Object({ ok: Type.Boolean() });
		const mock = createMockSessionFactory({ structuredResult: { ok: true } });
		const agent = new WorkflowAgent({
			createSession: mock.createSession,
			createCodingTools: () => [fakeTool("read"), fakeTool("write")],
			loadRole: () => fakeRole({ defaultSchema: schema }),
		});

		const result = await agent.run("Fix bug", {
			role: "developer",
			label: "fix bug",
			tools: [fakeTool("extra")],
		});

		expect(result).toEqual({ ok: true });
		expect(mock.calls[0].customTools?.map((tool) => tool.name)).toEqual(["read", "extra", "structured_output"]);
		expect(mock.prompts[0]).toContain("# Role: developer\nYou implement minimal diffs.");
		expect(mock.prompts[0]).toContain("Final output contract:");
	});

	it("lets call-level schema override role default schema", async () => {
		const roleSchema = Type.Object({ roleDefault: Type.Boolean() });
		const callSchema = Type.Object({ callOverride: Type.Boolean() });
		const mock = createMockSessionFactory({ structuredResult: { callOverride: true } });
		const agent = new WorkflowAgent({
			createSession: mock.createSession,
			createCodingTools: () => [],
			loadRole: () => fakeRole({ defaultSchema: roleSchema }),
		});

		await agent.run("Return structured", { role: "developer", schema: callSchema });

		const structuredTool = mock.calls[0].customTools?.find((tool) => tool.name === "structured_output");
		expect(structuredTool?.parameters).toBe(callSchema);
	});

	it("inherits pi-style agent resources by default and allows agentDir override", async () => {
		const mock = createMockSessionFactory();
		const agent = new WorkflowAgent({
			cwd: "/repo",
			agentDir: "/tmp/pi-agent",
			createSession: mock.createSession,
			createCodingTools: () => [],
		});

		await agent.run("Use default model");

		expect(mock.calls[0].agentDir).toBe("/tmp/pi-agent");
		expect(mock.calls[0].authStorage).toBeDefined();
		expect(mock.calls[0].modelRegistry).toBeDefined();
		expect(mock.calls[0].settingsManager).toBeDefined();
		expect(mock.calls[0].model).toBeUndefined();
	});

	it("resolves requested model and passes it to createAgentSession", async () => {
		const model = { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" } as PiModel;
		const modelRegistry = {
			find: (provider: string, modelId: string) =>
				provider === "anthropic" && modelId === "claude-sonnet" ? model : undefined,
			getAll: () => [model],
		} as unknown as CreateAgentSessionOptions["modelRegistry"];
		const mock = createMockSessionFactory();
		const agent = new WorkflowAgent({
			createSession: mock.createSession,
			createCodingTools: () => [],
			session: { modelRegistry },
		});

		await agent.run("Use model", { model: "anthropic:claude-sonnet" });

		expect(mock.calls[0].model).toBe(model);
		expect(mock.calls[0].modelRegistry).toBe(modelRegistry);
	});

	it("returns cached journal results without creating a pi session", async () => {
		const mock = createMockSessionFactory();
		const journal = createMockJournal();
		const seedKey = "seed";
		journal.entries.set(seedKey, { result: "cached result", tokens: 3 });
		const agent = new WorkflowAgent({
			cwd: "/repo",
			createSession: mock.createSession,
			createCodingTools: () => [],
			journal: {
				lookup: () => journal.lookup(seedKey),
				write: journal.write,
			},
		});

		const result = await agent.run("Summarize", { label: "label does not affect cache" });

		expect(result).toBe("cached result");
		expect(mock.calls).toHaveLength(0);
		expect(journal.writes).toHaveLength(0);
	});

	it("writes successful agent results to the journal", async () => {
		const mock = createMockSessionFactory();
		const journal = createMockJournal();
		const agent = new WorkflowAgent({
			cwd: "/repo",
			createSession: mock.createSession,
			createCodingTools: () => [],
			journal,
		});

		const result = await agent.run("Summarize", { role: undefined, model: undefined, instructions: "Be brief." });

		expect(result).toBe("final text");
		expect(journal.lookups).toHaveLength(1);
		expect(journal.writes).toHaveLength(1);
		expect(journal.writes[0].cacheKey).toBe(journal.lookups[0]);
		expect(journal.writes[0].input).toEqual({ result: "final text", tokens: 3 });
	});

	it("throws when structured output is required but not called", async () => {
		const mock = createMockSessionFactory();
		const agent = new WorkflowAgent({ createSession: mock.createSession, createCodingTools: () => [] });

		await expect(agent.run("Return structured", { schema: Type.Object({ ok: Type.Boolean() }) })).rejects.toThrow(
			/without calling structured_output/,
		);
	});
});

describe("resolveModelSpec", () => {
	it("resolves explicit provider:model and provider/model specs", () => {
		const anthropic = { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" } as PiModel;
		const openrouter = { provider: "openrouter", id: "anthropic/claude-sonnet", name: "OpenRouter Sonnet" } as PiModel;
		const modelRegistry = {
			find(provider: string, modelId: string) {
				return [anthropic, openrouter].find((model) => model.provider === provider && model.id === modelId);
			},
			getAll: () => [anthropic, openrouter],
		} as unknown as CreateAgentSessionOptions["modelRegistry"];

		expect(resolveModelSpec("anthropic:claude-sonnet", { modelRegistry })).toBe(anthropic);
		expect(resolveModelSpec("openrouter/anthropic/claude-sonnet", { modelRegistry })).toBe(openrouter);
	});

	it("resolves bare id or display name only when unique", () => {
		const a = { provider: "p1", id: "same-id", name: "A" } as PiModel;
		const b = { provider: "p2", id: "same-id", name: "B" } as PiModel;
		const unique = { provider: "p3", id: "unique-id", name: "Unique Model" } as PiModel;
		const modelRegistry = {
			find: () => undefined,
			getAll: () => [a, b, unique],
		} as unknown as CreateAgentSessionOptions["modelRegistry"];

		expect(resolveModelSpec("unique-id", { modelRegistry })).toBe(unique);
		expect(resolveModelSpec("Unique Model", { modelRegistry })).toBe(unique);
		expect(resolveModelSpec("same-id", { modelRegistry })).toBeUndefined();
	});
});
