// Portions of this file are derived from pi-dynamic-workflows
// (https://github.com/Michaelliv/pi-dynamic-workflows), MIT licensed.

import type { TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import { parseWorkflowScript, runWorkflow } from "./runtime.ts";
import type { AgentRunOptions, AgentRunResult } from "./workflow-agent.ts";

const validScript = `export const meta = {
  name: 'demo_workflow',
  description: 'A useful workflow',
  whenToUse: 'When testing parser behavior',
  phases: [{ title: 'Scan', detail: 'Collect inputs', model: 'default' }]
}

phase('Scan')
return { ok: true }
`;

describe("parseWorkflowScript", () => {
	it("accepts literal workflow metadata", () => {
		const parsed = parseWorkflowScript(validScript);
		expect(parsed.meta.name).toBe("demo_workflow");
		expect(parsed.meta.description).toBe("A useful workflow");
		expect(parsed.meta.phases).toEqual([{ title: "Scan", detail: "Collect inputs", model: "default" }]);
		expect(parsed.body).toMatch(/phase\('Scan'\)/);
		expect(parsed.body).not.toMatch(/export const meta/);
	});

	it("accepts static template literals", () => {
		const parsed = parseWorkflowScript("export const meta = { name: `demo`, description: `static` }\nreturn true");
		expect(parsed.meta.name).toBe("demo");
		expect(parsed.meta.description).toBe("static");
	});

	it("requires meta export first", () => {
		expect(() => parseWorkflowScript("const x = 1\nexport const meta = { name: 'demo', description: 'desc' }")).toThrow(
			/must be the first statement/,
		);
	});

	it("requires name and description", () => {
		expect(() => parseWorkflowScript("export const meta = { name: 'demo' }")).toThrow(/meta.description/);
		expect(() => parseWorkflowScript("export const meta = { description: 'desc' }")).toThrow(/meta.name/);
	});

	it("rejects non-literal metadata", () => {
		expect(() => parseWorkflowScript("export const meta = { name: makeName(), description: 'desc' }")).toThrow(
			/non-literal node type.*CallExpression/,
		);
		expect(() => parseWorkflowScript("const name = 'demo'; export const meta = { name, description: 'desc' }")).toThrow(
			/must be the first statement/,
		);
		expect(() => parseWorkflowScript("export const meta = { name: name, description: 'desc' }")).toThrow(
			/non-literal node type.*Identifier/,
		);
	});

	it("rejects object hazards", () => {
		expect(() => parseWorkflowScript("export const meta = { ...base, name: 'demo', description: 'desc' }")).toThrow(
			/spread not allowed/,
		);
		expect(() => parseWorkflowScript("export const meta = { ['name']: 'demo', description: 'desc' }")).toThrow(
			/computed keys not allowed/,
		);
		expect(() =>
			parseWorkflowScript("export const meta = { __proto__: {}, name: 'demo', description: 'desc' }"),
		).toThrow(/reserved key name/);
		expect(() =>
			parseWorkflowScript("export const meta = { get name() { return 'demo' }, description: 'desc' }"),
		).toThrow(/methods\/accessors not allowed/);
	});

	it("rejects array hazards", () => {
		expect(() =>
			parseWorkflowScript("export const meta = { name: 'demo', description: 'desc', phases: [,,] }"),
		).toThrow(/sparse arrays not allowed/);
		expect(() =>
			parseWorkflowScript("export const meta = { name: 'demo', description: 'desc', phases: [...items] }"),
		).toThrow(/spread not allowed/);
	});

	it("rejects template interpolation", () => {
		expect(() => parseWorkflowScript("export const meta = { name: `demo_$" + "{id}`, description: 'desc' }")).toThrow(
			/template interpolation not allowed/,
		);
	});

	it("rejects nondeterministic APIs", () => {
		expect(() =>
			parseWorkflowScript("export const meta = { name: 'demo', description: 'desc' }\nreturn Date.now()"),
		).toThrow(/must be deterministic/);
		expect(() =>
			parseWorkflowScript("export const meta = { name: 'demo', description: 'desc' }\nreturn Math.random()"),
		).toThrow(/must be deterministic/);
		expect(() =>
			parseWorkflowScript("export const meta = { name: 'demo', description: 'desc' }\nreturn new Date()"),
		).toThrow(/must be deterministic/);
	});
});

describe("runWorkflow", () => {
	it("handles request_human through gate and journal", async () => {
		const humanResponses = new Map<string, unknown>();
		const created: Array<{ requestId: string; cacheKey: string; request: unknown }> = [];
		const written: Array<{ cacheKey: string; response: unknown }> = [];
		const script = `export const meta = { name: 'human_demo', description: 'Human demo' }
const response = await request_human({ title: 'Approve?', options: ['yes', 'no'] })
return response
`;

		const result = await runWorkflow(script, {
			taskId: "T-1",
			journal: {
				lookupHuman<T = unknown>(cacheKey: string) {
					const response = humanResponses.get(cacheKey);
					return response ? { response: response as T } : null;
				},
				writeHuman(cacheKey, response) {
					written.push({ cacheKey, response });
					humanResponses.set(cacheKey, response);
				},
			},
			human: {
				createRequest(input) {
					created.push(input);
				},
				async wait() {
					return { decision: "yes" };
				},
			},
		});

		expect(result.result).toEqual({ decision: "yes" });
		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({ requestId: "T-1_0", request: { title: "Approve?", options: ["yes", "no"] } });
		expect(written).toEqual([{ cacheKey: created[0].cacheKey, response: { decision: "yes" } }]);
	});

	it("reuses cached human responses", async () => {
		const script = `export const meta = { name: 'human_cached', description: 'Human cached' }
return await request_human({ title: 'Approve?' })
`;
		const result = await runWorkflow(script, {
			journal: {
				lookupHuman<T = unknown>() {
					return { response: { decision: "cached" } as T };
				},
				writeHuman() {
					throw new Error("should not write cached response");
				},
			},
			human: {
				async wait() {
					throw new Error("should not wait for cached response");
				},
			},
		});

		expect(result.result).toEqual({ decision: "cached" });
	});

	it("throws when request_human is not configured", async () => {
		const script = `export const meta = { name: 'human_missing', description: 'Human missing' }
return await request_human({ title: 'Approve?' })
`;

		await expect(runWorkflow(script)).rejects.toThrow(/request_human\(\) is not configured/);
	});

	it("passes role, model, phase, label, and instructions into agent calls", async () => {
		const calls: Array<{ prompt: string; options: AgentRunOptions<TSchema | undefined> }> = [];
		const script = `export const meta = { name: 'role_demo', description: 'Role demo' }
phase('Develop')
const result = await agent('Implement it', {
  label: 'dev task',
  role: 'developer',
  model: 'model-from-script',
  instructions: 'Prefer minimal diffs.'
})
return result
`;

		const result = await runWorkflow(script, {
			agent: {
				async run<TSchemaDef extends TSchema | undefined = undefined>(
					prompt: string,
					options: AgentRunOptions<TSchemaDef> = {},
				): Promise<AgentRunResult<TSchemaDef>> {
					calls.push({ prompt, options });
					return "done" as AgentRunResult<TSchemaDef>;
				},
			},
		});

		expect(result.result).toBe("done");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			prompt: "Implement it",
			options: {
				label: "dev task",
				role: "developer",
				model: "model-from-script",
				instructions: "Workflow phase: Develop\nRequested model: model-from-script\nPrefer minimal diffs.",
			},
		});
	});
});
