// Portions of this file are derived from pi-dynamic-workflows
// (https://github.com/Michaelliv/pi-dynamic-workflows), MIT licensed.

import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import { parseWorkflowScript, runWorkflow } from "./runtime.ts";
import type { AgentRunOptions, AgentRunResult } from "./workflow-agent.ts";

const stubAgent = {
	run: async <TSchemaDef extends TSchema | undefined = undefined>(
		_prompt: string,
		_options: AgentRunOptions<TSchemaDef> = {},
	): Promise<AgentRunResult<TSchemaDef>> => "ok" as AgentRunResult<TSchemaDef>,
};

const semanticRoleLoader = async (name: string) => ({
	name,
	dir: `/roles/${name}`,
	systemPrompt: `You are ${name}.`,
	tools: { allow: [], extensions: [] },
	extensionPaths: [],
});

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

	it("allows prompts that mention nondeterministic API names", () => {
		const parsed = parseWorkflowScript(`export const meta = { name: 'demo', description: 'desc' }
return await agent('Catalog Date.now(), Math.random(), and new Date() usage', { label: 'scan' })`);
		expect(parsed.body).toContain("Date.now()");
	});
});

describe("runWorkflow", () => {
	it("rejects non-string phase titles", async () => {
		const script = `export const meta = { name: 'bad_phase', description: 'Bad phase' }
phase(Promise.resolve('Scan'))
return { ok: true }
`;

		await expect(runWorkflow(script)).rejects.toThrow(/phase title must be a string/);
	});

	it("rejects non-string agent prompts", async () => {
		const script = `export const meta = { name: 'bad_agent_prompt', description: 'Bad agent prompt' }
return await agent({ prompt: 'scan' }, { label: 'scan' })
`;

		await expect(runWorkflow(script)).rejects.toThrow(/agent prompt must be a string/);
	});

	it("rejects invalid agent option types", async () => {
		const script = `export const meta = { name: 'bad_agent_options', description: 'Bad agent options' }
return await agent('scan', { label: 123 })
`;

		await expect(runWorkflow(script)).rejects.toThrow(/agent label must be a string/);
	});

	it("rejects unawaited agent promises before returning", async () => {
		let ended = 0;
		const script = `export const meta = { name: 'promise_leak', description: 'Promise leak' }
const scan = agent('scan', { label: 'scan' })
return { scan }
`;

		await expect(
			runWorkflow(script, {
				agent: {
					async run(prompt: string) {
						return `result:${prompt}` as never;
					},
				},
				onAgentEnd() {
					ended++;
				},
			}),
		).rejects.toThrow(/did you forget to await agent\(\), parallel\(\), or pipeline\(\)/);
		expect(ended).toBe(1);
	});

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
			model: "model-from-run",
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

	it("uses run-level model as default for agent calls", async () => {
		const calls: Array<{ prompt: string; options: AgentRunOptions<TSchema | undefined> }> = [];
		const script = `export const meta = { name: 'model_default', description: 'Model default' }
const direct = await agent('direct', { label: 'direct' })
return direct
`;

		await runWorkflow(script, {
			model: "xiaomi/mimo-v2.5-pro",
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

		expect(calls).toHaveLength(1);
		expect(calls[0].options.model).toBe("xiaomi/mimo-v2.5-pro");
		expect(calls[0].options.instructions).toContain("Requested model: xiaomi/mimo-v2.5-pro");
	});

	it("collects usage from agent calls and invokes onUsage callback", async () => {
		const usage = {
			input: 100,
			output: 50,
			cacheRead: 200,
			cacheWrite: 0,
			totalTokens: 350,
			cost: { input: 0.001, output: 0.002, cacheRead: 0.0003, cacheWrite: 0, total: 0.0033 },
		};
		const script = `export const meta = { name: 'usage_test', description: 'Usage test' }
return await agent('do something', { label: 'worker' })
`;

		const collected: unknown[] = [];
		await runWorkflow(script, {
			agent: {
				async run(_prompt: string, opts?: AgentRunOptions<TSchema | undefined>) {
					opts?.onUsage?.(usage as never);
					return "done" as never;
				},
			},
			onUsage: (u) => collected.push(u),
		});

		expect(collected).toHaveLength(1);
		expect(collected[0]).toMatchObject({ input: 100, output: 50, cost: { total: 0.0033 } });
	});

	it("aggregates usage from multiple agents into result.usage", async () => {
		const usageA = {
			input: 100,
			output: 50,
			cacheRead: 200,
			cacheWrite: 0,
			totalTokens: 350,
			cost: { input: 0.001, output: 0.002, cacheRead: 0.0003, cacheWrite: 0, total: 0.0033 },
		};
		const usageB = {
			input: 500,
			output: 200,
			cacheRead: 1000,
			cacheWrite: 0,
			totalTokens: 1700,
			cost: { input: 0.005, output: 0.006, cacheRead: 0.002, cacheWrite: 0, total: 0.013 },
		};
		let callCount = 0;
		const script = `export const meta = { name: 'usage_agg', description: 'Usage agg' }
await agent('a', { label: 'a' })
await agent('b', { label: 'b' })
return true
`;

		const result = await runWorkflow(script, {
			agent: {
				async run(_prompt: string, opts?: AgentRunOptions<TSchema | undefined>) {
					const u = callCount++ === 0 ? usageA : usageB;
					opts?.onUsage?.(u as never);
					return "ok" as never;
				},
			},
		});

		expect(result.usage.input).toBe(600);
		expect(result.usage.output).toBe(250);
		expect(result.usage.cacheRead).toBe(1200);
		expect(result.usage.totalTokens).toBe(2050);
		expect(result.usage.cost.total).toBeCloseTo(0.0163);
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

	it("dumps null then propagates agent failures", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kanade-artifact-"));
		const script = `export const meta = { name: 'test', description: 'Test' }
return await agent('task', { label: 'dev' })`;

		await expect(
			runWorkflow(script, {
				runDir: dir,
				dumpArtifacts: true,
				agent: {
					async run() {
						throw new Error("fail");
					},
				},
			}),
		).rejects.toThrow("fail");

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

describe("parallel cache_lead option", () => {
	it("parallel(thunks) without opts behaves as pure parallel (backward compatible)", async () => {
		const order: string[] = [];
		const script = `export const meta = { name: 'test', description: 'Test' }
await parallel([
  () => agent('a', { label: 'a' }),
  () => agent('b', { label: 'b' }),
  () => agent('c', { label: 'c' }),
])
return true`;

		await runWorkflow(script, {
			agent: {
				run: async () => {
					order.push(Date.now().toString());
					return "x" as never;
				},
			},
		});

		expect(order).toHaveLength(3);
	});

	it("parallel(thunks, { cache_lead: true }) lead completes before rest start", async () => {
		const timeline: Array<{ event: string; agent: string }> = [];
		const script = `export const meta = { name: 'test', description: 'Test' }
await parallel([
  () => agent('a', { label: 'a' }),
  () => agent('b', { label: 'b' }),
  () => agent('c', { label: 'c' }),
], { cache_lead: true })
return true`;

		let callCount = 0;
		await runWorkflow(script, {
			agent: {
				run: async () => {
					const id = String.fromCharCode(97 + callCount++); // a, b, c
					timeline.push({ event: "start", agent: id });
					await new Promise((r) => setTimeout(r, 10));
					timeline.push({ event: "end", agent: id });
					return "x" as never;
				},
			},
		});

		// Lead 'a' should end before 'b' and 'c' start
		const aEnd = timeline.findIndex((e) => e.event === "end" && e.agent === "a");
		const bStart = timeline.findIndex((e) => e.event === "start" && e.agent === "b");
		const cStart = timeline.findIndex((e) => e.event === "start" && e.agent === "c");
		expect(aEnd).toBeLessThan(bStart);
		expect(aEnd).toBeLessThan(cStart);
	});

	it("parallel(thunks) without opts runs all concurrently", async () => {
		const timeline: Array<{ event: string; agent: string }> = [];
		const script = `export const meta = { name: 'test', description: 'Test' }
await parallel([
  () => agent('a', { label: 'a' }),
  () => agent('b', { label: 'b' }),
  () => agent('c', { label: 'c' }),
])
return true`;

		let callCount = 0;
		await runWorkflow(script, {
			agent: {
				run: async () => {
					const id = String.fromCharCode(97 + callCount++);
					timeline.push({ event: "start", agent: id });
					await new Promise((r) => setTimeout(r, 10));
					timeline.push({ event: "end", agent: id });
					return "x" as never;
				},
			},
		});

		// All 3 agents ran and completed
		const starts = timeline.filter((e) => e.event === "start");
		const ends = timeline.filter((e) => e.event === "end");
		expect(starts).toHaveLength(3);
		expect(ends).toHaveLength(3);
		// First start happens before last end (concurrent, not sequential)
		const firstStartIdx = timeline.findIndex((e) => e.event === "start");
		const lastEndIdx = timeline.findLastIndex((e) => e.event === "end");
		expect(firstStartIdx).toBeLessThan(lastEndIdx);
	});

	it("parallel(thunks, { cache_lead: false }) forces pure parallel", async () => {
		const script = `export const meta = { name: 'test', description: 'Test' }
await parallel([
  () => agent('a', { label: 'a' }),
  () => agent('b', { label: 'b' }),
], { cache_lead: false })
return true`;

		let callCount = 0;
		await runWorkflow(script, {
			agent: {
				run: async () => {
					callCount++;
					return "x" as never;
				},
			},
		});

		expect(callCount).toBe(2);
	});

	it("cache_lead: true returns results in correct order", async () => {
		let callCount = 0;
		const script = `export const meta = { name: 'test', description: 'Test' }
const r = await parallel([
  () => agent('a', { label: 'a' }),
  () => agent('b', { label: 'b' }),
  () => agent('c', { label: 'c' }),
], { cache_lead: true })
return r`;

		const result = await runWorkflow(script, {
			agent: {
				run: async () => `result-${++callCount}` as never,
			},
		});

		expect(result.result).toEqual(["result-1", "result-2", "result-3"]);
	});

	it("cache_lead: true with failing lead returns null and continues", async () => {
		let callCount = 0;
		const script = `export const meta = { name: 'test', description: 'Test' }
const r = await parallel([
  () => agent('a', { label: 'a' }),
  () => agent('b', { label: 'b' }),
], { cache_lead: true })
return r`;

		const result = await runWorkflow(script, {
			agent: {
				run: async () => {
					callCount++;
					if (callCount === 1) throw new Error("lead failed");
					return "ok" as never;
				},
			},
		});

		expect(result.result).toEqual([null, "ok"]);
	});

	it("cache_lead: true with single thunk runs it directly", async () => {
		const script = `export const meta = { name: 'test', description: 'Test' }
const r = await parallel([
  () => agent('a', { label: 'a' }),
], { cache_lead: true })
return r`;

		const result = await runWorkflow(script, {
			agent: {
				run: async () => "single" as never,
			},
		});

		expect(result.result).toEqual(["single"]);
	});
});

describe("runWorkflow — budgets", () => {
	it("uses real session usage to enforce token budget", async () => {
		const script = `export const meta = { name: 'budget', description: 'Budget' }
await agent('first', { label: 'a' })
await agent('second', { label: 'b' })
return 'done'`;

		await expect(
			runWorkflow(script, {
				tokenBudget: 5,
				agent: {
					async run<TSchemaDef extends TSchema | undefined = undefined>(
						_prompt: string,
						options: AgentRunOptions<TSchemaDef> = {},
					): Promise<AgentRunResult<TSchemaDef>> {
						options.onUsage?.({
							input: 3,
							output: 4,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 7,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						});
						return "ok" as AgentRunResult<TSchemaDef>;
					},
				},
			}),
		).rejects.toThrow(/workflow token budget exhausted/);
	});

	it("falls back to result-size estimation when usage is unavailable", async () => {
		const script = `export const meta = { name: 'budget-fallback', description: 'Budget fallback' }
await agent('first', { label: 'a' })
await agent('second', { label: 'b' })
return 'done'`;

		await expect(
			runWorkflow(script, {
				tokenBudget: 1,
				agent: {
					async run<TSchemaDef extends TSchema | undefined = undefined>(): Promise<AgentRunResult<TSchemaDef>> {
						return "ok" as AgentRunResult<TSchemaDef>;
					},
				},
			}),
		).rejects.toThrow(/workflow token budget exhausted/);
	});
});

describe("runWorkflow — semantic helpers", () => {
	it("implements review-and-fix flow with semantic helpers", async () => {
		const calls: Array<{ prompt: string; options: AgentRunOptions<TSchema | undefined> }> = [];
		const script = `export const meta = { name: 'semantic_medium', description: 'Semantic medium flow' }
phase('Implement')
const dev = await implement('Do the change. Run focused tests.', { role: 'developer' })
phase('Review')
const review = await reviewChange(dev, {
  role: 'reviewer',
  guidance: 'Check correctness and test coverage.',
  output: { type: 'object', properties: { status: { type: 'string', enum: ['approved', 'needs_fix'] }, summary: { type: 'string' }, issues: { type: 'array', items: { type: 'string' } } }, required: ['status', 'summary'] }
})
if (review.status === 'needs_fix') {
  phase('Fix')
  const fix = await continueImplementation(dev, { role: 'developer', feedback: review, guidance: 'Address review issues.' })
  return { dev, review, fix }
}
return { dev, review }`;

		const result = await runWorkflow(script, {
			loadRole: semanticRoleLoader,
			agent: {
				async run<TSchemaDef extends TSchema | undefined = undefined>(
					prompt: string,
					options: AgentRunOptions<TSchemaDef> = {},
				): Promise<AgentRunResult<TSchemaDef>> {
					calls.push({ prompt, options });
					if (options.role === "reviewer") {
						return {
							status: "needs_fix",
							summary: "reviewed",
							issues: ["missing edge case"],
						} as AgentRunResult<TSchemaDef>;
					}
					return {
						status: "done",
						summary: "implemented",
						filesChanged: ["src/a.ts"],
						testsRun: "vitest",
					} as AgentRunResult<TSchemaDef>;
				},
			},
		});

		expect((result.result as { review: { status: string }; fix?: unknown }).review.status).toBe("needs_fix");
		expect((result.result as { fix?: unknown }).fix).toBeTruthy();
		expect(calls).toHaveLength(3);
		expect(calls[0].options.role).toBe("developer");
		expect(calls[1].options.role).toBe("reviewer");
		expect(calls[2].options.role).toBe("developer");
		expect(calls[1].prompt).toContain("Review the following implementation result");
		expect(calls[2].prompt).toContain("Continue the previous implementation");
		expect(calls[2].prompt).toContain("missing edge case");
	});

	it("rejects continueImplementation without feedback", async () => {
		const script = `export const meta = { name: 'no_feedback', description: 'No feedback' }
const dev = { status: 'done' }
return await continueImplementation(dev, { role: 'developer' })`;

		await expect(runWorkflow(script, { agent: stubAgent })).rejects.toThrow(
			/continueImplementation feedback is required/,
		);
	});

	it("rejects unsupported semantic helper option fields", async () => {
		const script = `export const meta = { name: 'bad_semantic_opts', description: 'Bad semantic opts' }
return await testChange({ artifact: { ok: true } }, { role: 'tester', command: 'npm test' })`;

		await expect(runWorkflow(script, { agent: stubAgent })).rejects.toThrow(
			/unsupported semantic step option: command/,
		);
	});

	it("falls back to prompt-only mode when canonical semantic roles are unavailable", async () => {
		const calls: Array<{ prompt: string; options: AgentRunOptions<TSchema | undefined> }> = [];
		const script = `export const meta = { name: 'semantic_fallback', description: 'Semantic fallback' }
const plan = await analyze('Plan the change.', { role: 'planner', guidance: 'Be concise.' })
const dev = await implement('Make the change.', { role: 'developer' })
const review = await reviewChange(dev, { role: 'reviewer' })
const validation = await testChange(dev, { role: 'tester' })
return { plan, dev, review, validation }`;

		await runWorkflow(script, {
			agent: {
				async run<TSchemaDef extends TSchema | undefined = undefined>(
					prompt: string,
					options: AgentRunOptions<TSchemaDef> = {},
				): Promise<AgentRunResult<TSchemaDef>> {
					calls.push({ prompt, options });
					if (prompt.includes("Review the following implementation result")) {
						return { status: "approved", summary: "ok", issues: [] } as AgentRunResult<TSchemaDef>;
					}
					return "ok" as AgentRunResult<TSchemaDef>;
				},
			},
		});

		expect(calls).toHaveLength(4);
		expect(calls.map((call) => call.options.role)).toEqual([undefined, undefined, undefined, undefined]);
		expect(calls[0].options.instructions).toContain("Act as a careful planner");
		expect(calls[0].options.instructions).toContain("Be concise.");
		expect(calls[1].options.instructions).toContain("Act as a careful developer");
		expect(calls[1].options.isolation).toBe("worktree");
		expect(calls[2].options.instructions).toContain("Act as a careful reviewer");
		expect(calls[2].options.isolation).toBe("worktree");
		expect(calls[3].options.instructions).toContain("Act as a careful tester");
		expect(calls[3].options.isolation).toBe("worktree");
	});

	it("applies default review schema when output is omitted", async () => {
		const calls: Array<{ options: AgentRunOptions<TSchema | undefined> }> = [];
		const script = `export const meta = { name: 'default_review_schema', description: 'Default review schema' }
const dev = await implement('Do the change.', { role: 'developer' })
return await reviewChange(dev, { role: 'reviewer' })`;

		await runWorkflow(script, {
			loadRole: semanticRoleLoader,
			agent: {
				async run<TSchemaDef extends TSchema | undefined = undefined>(
					_prompt: string,
					options: AgentRunOptions<TSchemaDef> = {},
				): Promise<AgentRunResult<TSchemaDef>> {
					calls.push({ options });
					if (options.role === "reviewer") {
						return { status: "approved", summary: "ok", issues: [] } as AgentRunResult<TSchemaDef>;
					}
					return { status: "done", summary: "implemented" } as AgentRunResult<TSchemaDef>;
				},
			},
		});

		const reviewCall = calls.find((call) => call.options.role === "reviewer");
		expect(reviewCall?.options.schema).toMatchObject({
			type: "object",
			properties: {
				status: { type: "string", enum: ["approved", "needs_fix"] },
				summary: { type: "string" },
				issues: { type: "array", items: { type: "string" } },
			},
		});
	});
});

describe("runWorkflow — script syntax validation", () => {
	it("rejects script with unterminated string constant", async () => {
		const script = `export const meta = { name: 'test', description: 'Test' }
const x = 'hello
world'`;
		await expect(runWorkflow(script)).rejects.toThrow(/Unterminated string/i);
	});

	it("rejects script with multiline single-quoted string in agent prompt", async () => {
		const script = `export const meta = { name: 'test', description: 'Test' }
const r = await agent('this prompt
spans multiple lines', { label: 'test' })
return r`;
		await expect(runWorkflow(script, { agent: stubAgent })).rejects.toThrow(/Unterminated string/i);
	});
});
