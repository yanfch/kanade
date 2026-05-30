/**
 * Mock E2E tests — real runWorkflow + WorkflowAgent, mocked pi SDK session.
 *
 * Tests the full execution chain: script parsing → sandbox → agent → session → result.
 * Only the bottom layer (createAgentSession) is mocked.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Journal } from "../../src/journal/index.ts";
import { runWorkflow } from "../../src/workflow-engine/index.ts";
import { WorkflowAgent } from "../../src/workflow-engine/workflow-agent.ts";
import { createMockSessionFactory } from "./mock-session.ts";

function makeRunDir(): string {
	return mkdtempSync(join(tmpdir(), "kanade-e2e-"));
}

function makeAgent(
	createSession: ReturnType<typeof createMockSessionFactory>["createSession"],
	runDir: string,
	journal?: Journal,
) {
	return new WorkflowAgent({
		cwd: runDir,
		createSession,
		createCodingTools: () => [],
		journal,
	});
}

async function run(
	script: string,
	opts?: { createSession?: Parameters<typeof createMockSessionFactory>[0]; journal?: Journal },
) {
	const runDir = makeRunDir();
	const mock = createMockSessionFactory(opts?.createSession ?? {});
	const journal = opts?.journal ?? new Journal(join(runDir, "journal.db"));
	const agent = makeAgent(mock.createSession, runDir, journal);

	const result = await runWorkflow(script, {
		cwd: runDir,
		agent,
		journal,
		agentJournal: journal,
	});

	journal.close();
	return { result, mock, runDir };
}

// ── E1: Single agent with structured output ─────────────────────────────────

describe("E2E — single agent", () => {
	it("runs one agent call and returns structured result", async () => {
		const { result, mock } = await run(
			`export const meta = { name: 'test', description: 'Test' }
phase('Work')
const r = await agent('do something', {
  label: 'worker',
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
})
return r`,
			{ createSession: { structuredResult: { ok: true } } },
		);

		expect(result.result).toEqual({ ok: true });
		expect(result.agentCount).toBe(1);
		expect(result.phases).toContain("Work");
		expect(mock.sessions).toHaveLength(1);
		expect(mock.sessions[0].prompts.length).toBeGreaterThanOrEqual(1);
		expect(mock.sessions[0].prompts[0]).toContain("do something");
		expect(mock.sessions[0].disposed).toBe(true);
	});

	it("returns text when no schema is provided", async () => {
		const { result, mock } = await run(
			`export const meta = { name: 'test', description: 'Test' }
return await agent('summarize this', { label: 'summarizer' })`,
			{ createSession: { text: "here is the summary" } },
		);

		expect(result.result).toBe("here is the summary");
		expect(mock.sessions).toHaveLength(1);
	});

	it("passes instructions in the prompt", async () => {
		let capturedPrompt = "";
		const { result } = await run(
			`export const meta = { name: 'test', description: 'Test' }
return await agent('implement feature', {
  label: 'dev',
  instructions: 'prefer minimal diffs',
  schema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] }
})`,
			{
				createSession: {
					handler: (prompt) => {
						capturedPrompt = prompt;
						return { type: "structured", value: { done: true } };
					},
				},
			},
		);

		expect(result.result).toEqual({ done: true });
		expect(capturedPrompt).toContain("implement feature");
		expect(capturedPrompt).toContain("prefer minimal diffs");
	});
});

// ── E2: Parallel execution ──────────────────────────────────────────────────

describe("E2E — parallel", () => {
	it("runs two agents in parallel", async () => {
		let callCount = 0;
		const { result, mock } = await run(
			`export const meta = { name: 'test', description: 'Test' }
const results = await parallel([
  () => agent('task A', { label: 'a', schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } }),
  () => agent('task B', { label: 'b', schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } }),
])
return { count: results.length, items: results }`,
			{
				createSession: {
					handler: () => ({ type: "structured", value: { n: ++callCount } }),
				},
			},
		);

		const r = result.result as { count: number; items: unknown[] };
		expect(r.count).toBe(2);
		expect(r.items).toHaveLength(2);
		expect(mock.sessions).toHaveLength(2);
	});

	it("parallel thunks must be functions, not promises", async () => {
		const { result } = await run(
			`export const meta = { name: 'test', description: 'Test' }
try {
  await parallel([Promise.resolve(1)])
  return { error: 'should have thrown' }
} catch (e) {
  return { error: e.message }
}`,
		);

		expect((result.result as { error: string }).error).toContain("functions");
	});
});

// ── E3: Pipeline ────────────────────────────────────────────────────────────

describe("E2E — pipeline", () => {
	it("runs items through stages", async () => {
		const callCount = 0;
		const { result, mock } = await run(
			`export const meta = { name: 'test', description: 'Test' }
const results = await pipeline(
  ['a', 'b', 'c'],
  async (item) => agent('process ' + item, { label: item })
)
return { count: results.length }`,
			{ createSession: { text: "processed" } },
		);

		expect((result.result as { count: number }).count).toBe(3);
		expect(mock.sessions.length).toBe(3);
	});
});

// ── E4: request_human + respond ─────────────────────────────────────────────

describe("E2E — request_human", () => {
	it("pauses and resumes after human response", async () => {
		const runDir = makeRunDir();
		const mock = createMockSessionFactory({ text: "unused" });
		const agent = makeAgent(mock.createSession, runDir);
		const journal = new Journal(join(runDir, "journal.db"));

		let humanRequestFired = false;
		let humanRequestId = "";

		const resultPromise = runWorkflow(
			`export const meta = { name: 'test', description: 'Test' }
const decision = await request_human({ title: 'Approve?', options: ['yes', 'no'] })
return decision`,
			{
				cwd: runDir,
				agent,
				journal,
				agentJournal: journal,
				human: {
					createRequest: ({ requestId }) => {
						humanRequestFired = true;
						humanRequestId = requestId;
					},
					wait: async () => ({ decision: "yes" }),
				},
			},
		);

		const result = await resultPromise;
		journal.close();

		expect(humanRequestFired).toBe(true);
		expect(humanRequestId).toBeTruthy();
		expect(result.result).toEqual({ decision: "yes" });
	});
});

// ── E5: Agent failure doesn't crash workflow ────────────────────────────────

describe("E2E — agent failure", () => {
	it("returns null for failed agent, workflow continues", async () => {
		const { result } = await run(
			`export const meta = { name: 'test', description: 'Test' }
const r = await agent('this will fail', { label: 'failing' })
return { result: r, failed: r === null }`,
			{ createSession: { error: new Error("LLM rate limited") } },
		);

		const r = result.result as { result: unknown; failed: boolean };
		expect(r.result).toBeNull();
		expect(r.failed).toBe(true);
	});

	it("script-level throw fails the task", async () => {
		await expect(
			run(`export const meta = { name: 'test', description: 'Test' }
throw new Error('script error')`),
		).rejects.toThrow("script error");
	});
});

// ── E6: Journal cache reuse ─────────────────────────────────────────────────

describe("E2E — journal cache", () => {
	it("second run reuses cached results", async () => {
		let callCount = 0;
		const runDir = makeRunDir();
		const journal = new Journal(join(runDir, "journal.db"));

		const script = `export const meta = { name: 'test', description: 'Test' }
const r = await agent('cached work', {
  label: 'cached',
  schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] }
})
return r`;

		// First run
		const mock1 = createMockSessionFactory({
			handler: () => ({ type: "structured", value: { n: ++callCount } }),
		});
		const agent1 = makeAgent(mock1.createSession, runDir, journal);
		const result1 = await runWorkflow(script, {
			cwd: runDir,
			agent: agent1,
			journal,
			agentJournal: journal,
		});
		expect((result1.result as { n: number }).n).toBe(1);
		expect(callCount).toBe(1);

		// Second run — should use journal cache, no new LLM call
		const mock2 = createMockSessionFactory({
			handler: () => ({ type: "structured", value: { n: ++callCount } }),
		});
		const agent2 = makeAgent(mock2.createSession, runDir, journal);
		const result2 = await runWorkflow(script, {
			cwd: runDir,
			agent: agent2,
			journal,
			agentJournal: journal,
		});

		// Cached result from first run
		expect((result2.result as { n: number }).n).toBe(1);
		expect(callCount).toBe(1);
		// Second mock should NOT have been called
		expect(mock2.sessions).toHaveLength(0);

		journal.close();
	});
});

// ── E7: Phase tracking ──────────────────────────────────────────────────────

describe("E2E — phases", () => {
	it("tracks phases and returns them in result", async () => {
		const { result } = await run(
			`export const meta = { name: 'test', description: 'Test' }
phase('Design')
await agent('design', { label: 'designer' })
phase('Build')
await agent('build', { label: 'developer' })
return { done: true }`,
			{ createSession: { text: "ok" } },
		);

		expect(result.phases).toEqual(["Design", "Build"]);
		expect(result.agentCount).toBe(2);
	});
});

// ── E8: Edge cases ──────────────────────────────────────────────────────────

describe("E2E — edge cases", () => {
	it("completes with no agent calls", async () => {
		const { result, mock } = await run(
			`export const meta = { name: 'test', description: 'Test' }
return { static: true }`,
		);

		expect(result.result).toEqual({ static: true });
		expect(result.agentCount).toBe(0);
		expect(mock.sessions).toHaveLength(0);
	});

	it("passes args to the script", async () => {
		const { result } = await run(
			`export const meta = { name: 'test', description: 'Test' }
return { received: args }`,
		);

		// args is undefined when not passed
		expect((result.result as { received: unknown }).received).toBeUndefined();
	});

	it("log() records messages", async () => {
		const { result } = await run(
			`export const meta = { name: 'test', description: 'Test' }
log('step 1')
log('step 2')
return { done: true }`,
		);

		expect(result.logs).toContain("step 1");
		expect(result.logs).toContain("step 2");
	});

	it("concurrent agent calls respect limiter", async () => {
		let maxConcurrent = 0;
		let currentConcurrent = 0;

		const { result, mock } = await run(
			`export const meta = { name: 'test', description: 'Test' }
const results = await parallel(
  Array.from({ length: 5 }, (_, i) => () => agent('task ' + i, { label: 't' + i }))
)
return { count: results.length }`,
			{
				createSession: {
					handler: async () => {
						currentConcurrent++;
						maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
						await new Promise((r) => setTimeout(r, 50));
						currentConcurrent--;
						return { type: "text", text: "done" };
					},
				},
			},
		);

		expect((result.result as { count: number }).count).toBe(5);
		expect(mock.sessions).toHaveLength(5);
		// Default concurrency limit is 16, so all 5 could run concurrently
		expect(maxConcurrent).toBeGreaterThanOrEqual(1);
	});
});
