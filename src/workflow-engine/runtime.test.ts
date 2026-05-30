// Portions of this file are derived from pi-dynamic-workflows
// (https://github.com/Michaelliv/pi-dynamic-workflows), MIT licensed.

import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("artifact dump", () => {
	it("writes agent results to JSON files when dumpArtifacts=true", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kanade-artifact-"));
		const script = `export const meta = { name: 'test', description: 'Test' }
phase('Work')
const a = await agent('task A', { label: 'designer' })
const b = await agent('task B', { label: 'developer' })
return { a, b }`;

		const result = await runWorkflow(script, {
			runDir: dir,
			dumpArtifacts: true,
			agent: {
				async run() {
					return { ok: true } as never;
				},
			},
		});

		expect(result.result).toEqual({ a: { ok: true }, b: { ok: true } });

		const artifactsDir = join(dir, "debug", "artifacts");
		expect(existsSync(artifactsDir)).toBe(true);

		const files = readdirSync(artifactsDir).sort();
		expect(files).toHaveLength(2);
		expect(files[0]).toMatch(/01-designer\.json/);
		expect(files[1]).toMatch(/02-developer\.json/);

		const content = JSON.parse(readFileSync(join(artifactsDir, files[0]), "utf8"));
		expect(content).toEqual({ ok: true });
	});

	it("does not write files when dumpArtifacts is not set", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kanade-artifact-"));
		const script = `export const meta = { name: 'test', description: 'Test' }
return await agent('task', { label: 'dev' })`;

		await runWorkflow(script, {
			runDir: dir,
			agent: {
				async run() {
					return "done" as never;
				},
			},
		});

		const artifactsDir = join(dir, "debug", "artifacts");
		expect(existsSync(artifactsDir)).toBe(false);
	});

	it("skips dump when agent returns null (failed)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kanade-artifact-"));
		const script = `export const meta = { name: 'test', description: 'Test' }
return await agent('task', { label: 'dev' })`;

		await runWorkflow(script, {
			runDir: dir,
			dumpArtifacts: true,
			agent: {
				async run() {
					throw new Error("fail");
				},
			},
		});

		const artifactsDir = join(dir, "debug", "artifacts");
		// null results are still dumped (shows the agent was called)
		expect(existsSync(artifactsDir)).toBe(true);
		const files = readdirSync(artifactsDir);
		expect(files).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(artifactsDir, files[0]), "utf8"))).toBeNull();
	});

	it("no-ops when dumpArtifacts=true but runDir is not set", async () => {
		const script = `export const meta = { name: 'test', description: 'Test' }
return await agent('task', { label: 'dev' })`;

		// No runDir — should not throw
		const result = await runWorkflow(script, {
			dumpArtifacts: true,
			agent: {
				async run() {
					return "ok" as never;
				},
			},
		});

		expect(result.result).toBe("ok");
	});

	it("sanitizes labels with special characters", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kanade-artifact-"));
		const script = `export const meta = { name: 'test', description: 'Test' }
const a = await agent('task', { label: 'src/config.ts' })
return a`;

		await runWorkflow(script, {
			runDir: dir,
			dumpArtifacts: true,
			agent: {
				async run() {
					return { ok: true } as never;
				},
			},
		});

		const files = readdirSync(join(dir, "debug", "artifacts"));
		expect(files).toHaveLength(1);
		// Slashes and dots should be replaced with underscores
		expect(files[0]).toMatch(/01-src_config_ts\.json/);
	});

	it("assigns sequential numbers to multiple agents", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kanade-artifact-"));
		const script = `export const meta = { name: 'test', description: 'Test' }
await agent('a', { label: 'first' })
await agent('b', { label: 'second' })
await agent('c', { label: 'third' })
return true`;

		await runWorkflow(script, {
			runDir: dir,
			dumpArtifacts: true,
			agent: {
				async run() {
					return "x" as never;
				},
			},
		});

		const files = readdirSync(join(dir, "debug", "artifacts")).sort();
		expect(files).toEqual(["01-first.json", "02-second.json", "03-third.json"]);
	});

	it("parallel agents get sequential numbers based on completion order", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kanade-artifact-"));
		const script = `export const meta = { name: 'test', description: 'Test' }
await parallel([
  () => agent('a', { label: 'alpha' }),
  () => agent('b', { label: 'beta' }),
])
return true`;

		await runWorkflow(script, {
			runDir: dir,
			dumpArtifacts: true,
			agent: {
				async run() {
					return "x" as never;
				},
			},
		});

		const files = readdirSync(join(dir, "debug", "artifacts")).sort();
		expect(files).toHaveLength(2);
		expect(files[0]).toMatch(/^01-/);
		expect(files[1]).toMatch(/^02-/);
	});
});
