/**
 * Mock E2E tests — real TaskManager with injected mock session.
 *
 * Tests the FULL chain: TaskManager → runWorkflow → WorkflowAgent → session.
 * Only createAgentSession is mocked.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMockSessionFactory } from "./mock-session.ts";
import { createE2EContext, waitForTask } from "./setup.ts";

/**
 * Clean up git worktrees and branches created by worktree tests.
 * Test task IDs use "X-" prefix, so we only delete branches matching "kanade/X-".
 */
function cleanupBranches() {
	const testBranches: string[] = [];
	try {
		execSync("git worktree prune", { cwd: process.cwd(), stdio: "ignore" });
	} catch {}
	try {
		const out = execSync("git branch", { encoding: "utf8", cwd: process.cwd() });
		for (const line of out.split("\n")) {
			const branch = line.replace(/^[*+]\s*/, "").trim();
			if (branch.startsWith("kanade/X-")) testBranches.push(branch);
		}
	} catch {}
	for (const branch of testBranches) {
		try {
			const wtOut = execSync("git worktree list", { encoding: "utf8", cwd: process.cwd() });
			for (const line of wtOut.split("\n")) {
				const parts = line.split(/\s+/);
				const wtBranch = parts[2]?.replace(/^\[/g, "").replace(/\]$/g, "");
				if (wtBranch === branch && parts[0]) {
					execSync(`git worktree remove "${parts[0]}" --force`, { cwd: process.cwd(), stdio: "ignore" });
				}
			}
		} catch {}
		try {
			execSync(`git branch -D ${branch}`, { cwd: process.cwd(), stdio: "ignore" });
		} catch {}
	}
}

// ── E1: Single agent with structured output ─────────────────────────────────

describe("E2E — single agent", () => {
	it("runs one agent call and returns structured result", async () => {
		const mock = createMockSessionFactory({ structuredResult: { ok: true } });
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
phase('Work')
const r = await agent('do something', {
  label: 'worker',
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
})
return r`,
			});

			await waitForTask(ctx.taskManager, task.task_id);
			const row = ctx.taskManager.get(task.task_id);

			expect(row?.status).toBe("finished");
			expect(JSON.parse(row?.result ?? "null")).toEqual({ ok: true });
			expect(mock.sessions).toHaveLength(1);
			expect(mock.sessions[0].prompts[0]).toContain("do something");
			expect(mock.sessions[0].disposed).toBe(true);
		} finally {
			ctx.cleanup();
		}
	});

	it("returns text when no schema is provided", async () => {
		const mock = createMockSessionFactory({ text: "here is the summary" });
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
return await agent('summarize', { label: 's' })`,
			});

			await waitForTask(ctx.taskManager, task.task_id);
			const result = JSON.parse(ctx.taskManager.get(task.task_id)?.result ?? "null");
			expect(result).toBe("here is the summary");
		} finally {
			ctx.cleanup();
		}
	});

	it("passes instructions in the prompt", async () => {
		let capturedPrompt = "";
		const mock = createMockSessionFactory({
			handler: (prompt) => {
				capturedPrompt = prompt;
				return { type: "structured", value: { done: true } };
			},
		});
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
return await agent('implement feature', {
  label: 'dev',
  instructions: 'prefer minimal diffs',
  schema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] }
})`,
			});

			await waitForTask(ctx.taskManager, task.task_id);
			expect(capturedPrompt).toContain("implement feature");
			expect(capturedPrompt).toContain("prefer minimal diffs");
		} finally {
			ctx.cleanup();
		}
	});
});

// ── E2: Parallel execution ──────────────────────────────────────────────────

describe("E2E — parallel", () => {
	it("runs two agents in parallel", async () => {
		let callCount = 0;
		const mock = createMockSessionFactory({
			handler: () => ({ type: "structured", value: { n: ++callCount } }),
		});
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
const results = await parallel([
  () => agent('task A', { label: 'a', schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } }),
  () => agent('task B', { label: 'b', schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } }),
])
return { count: results.length, items: results }`,
			});

			await waitForTask(ctx.taskManager, task.task_id);
			const result = JSON.parse(ctx.taskManager.get(task.task_id)?.result ?? "null");

			expect(result.count).toBe(2);
			expect(result.items).toHaveLength(2);
			expect(mock.sessions).toHaveLength(2);
		} finally {
			ctx.cleanup();
		}
	});
});

// ── E3: Pipeline ────────────────────────────────────────────────────────────

describe("E2E — pipeline", () => {
	it("runs items through stages", async () => {
		const mock = createMockSessionFactory({ text: "processed" });
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
const results = await pipeline(['a', 'b', 'c'], async (item) => agent('process ' + item, { label: item }))
return { count: results.length }`,
			});

			await waitForTask(ctx.taskManager, task.task_id);
			const result = JSON.parse(ctx.taskManager.get(task.task_id)?.result ?? "null");
			expect(result.count).toBe(3);
			expect(mock.sessions).toHaveLength(3);
		} finally {
			ctx.cleanup();
		}
	});
});

// ── E4: request_human + respond ─────────────────────────────────────────────

describe("E2E — request_human", () => {
	it("pauses and resumes after respond", async () => {
		const mock = createMockSessionFactory({ text: "unused" });
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
const decision = await request_human({ title: 'Approve?', options: ['yes', 'no'] })
return decision`,
			});

			await waitForTask(ctx.taskManager, task.task_id, "needs_human", 5000);
			expect(ctx.taskManager.get(task.task_id)?.status).toBe("needs_human");

			const pending = ctx.store.listPendingNeedsHuman().find((r) => r.task_id === task.task_id);
			expect(pending).toBeDefined();

			ctx.taskManager.respond(task.task_id, pending!.request_id, { decision: "yes" });

			await waitForTask(ctx.taskManager, task.task_id, "finished", 5000);
			const result = JSON.parse(ctx.taskManager.get(task.task_id)?.result ?? "null");
			expect(result).toEqual({ decision: "yes" });
		} finally {
			ctx.cleanup();
		}
	});
});

// ── E5: Agent failure ───────────────────────────────────────────────────────

describe("E2E — agent failure", () => {
	it("agent failure propagates error and task fails", async () => {
		const mock = createMockSessionFactory({ error: new Error("LLM rate limited") });
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
const r = await agent('this will fail', { label: 'failing' })
return { result: r, failed: r === null }`,
			});

			await waitForTask(ctx.taskManager, task.task_id, "failed", 5000);
			const row = ctx.taskManager.get(task.task_id);
			expect(row?.status).toBe("failed");
			expect(row?.error).toContain("LLM rate limited");
		} finally {
			ctx.cleanup();
		}
	});

	it("script-level throw sets task status to failed", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
throw new Error('script error')`,
			});

			await waitForTask(ctx.taskManager, task.task_id, "failed", 5000);
			const row = ctx.taskManager.get(task.task_id);
			expect(row?.status).toBe("failed");
			expect(row?.error).toContain("script error");
		} finally {
			ctx.cleanup();
		}
	});
});

// ── E6: Journal cache reuse ─────────────────────────────────────────────────

describe("E2E — rerun with journal cache", () => {
	it("second run reuses cached agent results", async () => {
		let callCount = 0;
		const mock = createMockSessionFactory({
			handler: () => ({ type: "structured", value: { n: ++callCount } }),
		});
		const ctx = createE2EContext(mock.createSession);
		try {
			const task1 = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
return await agent('cached work', {
  label: 'cached',
  schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] }
})`,
			});

			await waitForTask(ctx.taskManager, task1.task_id);
			expect(JSON.parse(ctx.taskManager.get(task1.task_id)?.result ?? "null")).toEqual({ n: 1 });
			expect(callCount).toBe(1);

			// Rerun — should use journal cache
			const task2 = ctx.taskManager.rerun(task1.task_id);
			await waitForTask(ctx.taskManager, task2.task_id);

			// Cached result from first run
			expect(JSON.parse(ctx.taskManager.get(task2.task_id)?.result ?? "null")).toEqual({ n: 1 });
			expect(callCount).toBe(1);
			expect(ctx.store.listAgentCalls(task1.task_id).map((call) => call.status)).toEqual(["completed"]);
			expect(ctx.store.listAgentCalls(task2.task_id).map((call) => call.status)).toEqual(["from_cache"]);
		} finally {
			ctx.cleanup();
		}
	});

	it("does not reuse cached agent results after workspace content changes", async () => {
		let callCount = 0;
		const mock = createMockSessionFactory({
			handler: () => ({ type: "structured", value: { n: ++callCount } }),
		});
		const ctx = createE2EContext(mock.createSession);
		try {
			const workspace = join(ctx.config.paths.root, "workspace-cache-change");
			mkdirSync(workspace, { recursive: true });
			writeFileSync(join(workspace, "state.txt"), "one\n");
			const task1 = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'cache-change', description: 'Test' }
return await agent('cached work', {
  label: 'cached',
  schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] }
})`,
				options: { cwd: workspace },
			});

			await waitForTask(ctx.taskManager, task1.task_id);
			expect(JSON.parse(ctx.taskManager.get(task1.task_id)?.result ?? "null")).toEqual({ n: 1 });
			writeFileSync(join(workspace, "state.txt"), "two\n");

			const task2 = ctx.taskManager.rerun(task1.task_id);
			await waitForTask(ctx.taskManager, task2.task_id);

			expect(JSON.parse(ctx.taskManager.get(task2.task_id)?.result ?? "null")).toEqual({ n: 2 });
			expect(callCount).toBe(2);
			expect(ctx.store.listAgentCalls(task2.task_id).map((call) => call.status)).toEqual(["completed"]);
		} finally {
			ctx.cleanup();
		}
	});
});

// ── E7: Complex semantic workflow ───────────────────────────────────────────

describe("E2E — complex workflow", () => {
	it("runs semantic phases, parallel analysis, review fix branch, validation, and records evidence", async () => {
		const mock = createMockSessionFactory({
			handler: (prompt) => {
				if (prompt.includes("Risk analysis")) {
					return { type: "structured", value: { status: "done", summary: "risk analyzed" } };
				}
				if (prompt.includes("Implementation plan")) {
					return { type: "structured", value: { status: "done", summary: "plan created" } };
				}
				if (prompt.includes("Implement the feature")) {
					return { type: "structured", value: { status: "done", summary: "implemented initial change" } };
				}
				if (prompt.includes("Review the following implementation result")) {
					return {
						type: "structured",
						value: { status: "needs_fix", summary: "edge case missing", issues: ["missing edge case"] },
					};
				}
				if (prompt.includes("Continue the previous implementation")) {
					return { type: "structured", value: { status: "done", summary: "edge case fixed" } };
				}
				if (prompt.includes("Validate the following implementation result")) {
					return {
						type: "structured",
						value: { status: "passed", summary: "focused tests passed", issues: [], warnings: [] },
					};
				}
				return { type: "structured", value: { status: "done", summary: "fallback" } };
			},
		});
		const ctx = createE2EContext(mock.createSession);
		try {
			const events: Array<{ type: string; data: unknown }> = [];
			ctx.events.onAny((event) => events.push({ type: event.type, data: event.data }));
			const stepSchema =
				"{ type: 'object', properties: { status: { type: 'string' }, summary: { type: 'string' } }, required: ['status', 'summary'] }";
			const validationSchema =
				"{ type: 'object', properties: { status: { type: 'string', enum: ['passed', 'failed'] }, summary: { type: 'string' }, issues: { type: 'array', items: { type: 'string' } }, warnings: { type: 'array', items: { type: 'string' } } }, required: ['status', 'summary', 'issues'] }";
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'complex-semantic', description: 'Complex semantic workflow' }
phase('Analyze')
const [risk, plan] = await parallel([
  () => analyze('Risk analysis', { label: 'risk', output: ${stepSchema} }),
  () => analyze('Implementation plan', { label: 'plan', output: ${stepSchema} }),
])
phase('Build')
const impl = await implement('Implement the feature', { label: 'implement', output: ${stepSchema} })
phase('Review')
const review = await reviewChange(impl, { label: 'review' })
if (review.status === 'needs_fix') {
  phase('Fix')
  const fixed = await continueImplementation(impl, { label: 'fix', feedback: review, output: ${stepSchema} })
  phase('Validate')
  const validation = await testChange(fixed, { label: 'validate', output: ${validationSchema} })
  return { risk, plan, impl, review, fixed, validation }
}
phase('Validate')
const validation = await testChange(impl, { label: 'validate', output: ${validationSchema} })
return { risk, plan, impl, review, validation }`,
			});

			await waitForTask(ctx.taskManager, task.task_id, "finished", 10_000);
			const result = JSON.parse(ctx.taskManager.get(task.task_id)?.result ?? "null") as {
				review: { status: string; issues: string[] };
				fixed?: { summary: string };
				validation: { status: string };
			};
			expect(result.review.status).toBe("needs_fix");
			expect(result.review.issues).toEqual(["missing edge case"]);
			expect(result.fixed?.summary).toBe("edge case fixed");
			expect(result.validation.status).toBe("passed");

			const phases = ctx.store.listPhases(task.task_id).map((phase) => phase.phase);
			expect(phases).toEqual(["Analyze", "Build", "Review", "Fix", "Validate"]);
			const agentCalls = ctx.store.listAgentCalls(task.task_id);
			expect(agentCalls.map((call) => call.label).sort()).toEqual([
				"fix",
				"implement",
				"plan",
				"review",
				"risk",
				"validate",
			]);
			expect(agentCalls.every((call) => call.status === "completed")).toBe(true);
			const startedLabels = events
				.filter((event) => event.type === "workflow.agent_started")
				.map((event) => (event.data as { label: string }).label);
			expect(startedLabels).toEqual(expect.arrayContaining(["risk", "plan", "implement", "review", "fix", "validate"]));
			const phaseEvents = events
				.filter((event) => event.type === "workflow.phase")
				.map((event) => (event.data as { phase: string }).phase);
			expect(phaseEvents).toEqual(["Analyze", "Build", "Review", "Fix", "Validate"]);
			const snapshot = ctx.taskManager.getSnapshot(task.task_id);
			expect(snapshot?.phases).toEqual(["Analyze", "Build", "Review", "Fix", "Validate"]);
			expect(snapshot?.agents.map((agent) => agent.label)).toEqual(
				expect.arrayContaining(["risk", "plan", "implement", "review", "fix", "validate"]),
			);
		} finally {
			ctx.cleanup();
			cleanupBranches();
		}
	});
});

// ── E8: Lifecycle events ────────────────────────────────────────────────────

describe("E2E — task lifecycle events", () => {
	it("emits complete event sequence", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createE2EContext(mock.createSession);
		try {
			const events: string[] = [];
			ctx.events.onAny((e) => events.push(e.type));

			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
phase('work')
return await agent('do it', { label: 'worker' })`,
			});

			await waitForTask(ctx.taskManager, task.task_id);

			expect(events).toContain("task.created");
			expect(events).toContain("task.running");
			expect(events).toContain("workflow.phase");
			expect(events).toContain("workflow.agent_started");
			expect(events).toContain("workflow.agent_completed");
			expect(events).toContain("task.finished");

			const createdIdx = events.indexOf("task.created");
			const runningIdx = events.indexOf("task.running");
			const finishedIdx = events.indexOf("task.finished");
			expect(runningIdx).toBeGreaterThan(createdIdx);
			expect(finishedIdx).toBeGreaterThan(runningIdx);
		} finally {
			ctx.cleanup();
		}
	});
});

// ── E8: Abort ───────────────────────────────────────────────────────────────

describe("E2E — abort", () => {
	it("abort during needs_human sets status to aborted", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
return await request_human({ title: 'Waiting...' })`,
			});

			await waitForTask(ctx.taskManager, task.task_id, "needs_human", 5000);
			await ctx.taskManager.abort(task.task_id);

			await waitForTask(ctx.taskManager, task.task_id, "aborted", 5000);
			expect(ctx.taskManager.get(task.task_id)?.status).toBe("aborted");
		} finally {
			ctx.cleanup();
		}
	});
});

// ── E9: Multi-phase ─────────────────────────────────────────────────────────

describe("E2E — multi-phase", () => {
	it("tracks phases and agent labels", async () => {
		let callCount = 0;
		const mock = createMockSessionFactory({
			handler: () => ({ type: "text", text: `result-${++callCount}` }),
		});
		const ctx = createE2EContext(mock.createSession);
		try {
			const agentEvents: Array<{ type: string; label: string }> = [];
			ctx.events.onAny((e) => {
				if (e.type === "workflow.agent_started") {
					agentEvents.push({ type: e.type, label: (e.data as { label: string }).label });
				}
			});

			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
phase('Design')
await agent('design', { label: 'designer' })
phase('Build')
await agent('build', { label: 'developer' })
return { done: true }`,
			});

			await waitForTask(ctx.taskManager, task.task_id);

			expect(agentEvents).toHaveLength(2);
			expect(agentEvents[0].label).toBe("designer");
			expect(agentEvents[1].label).toBe("developer");
			expect(mock.sessions).toHaveLength(2);
		} finally {
			ctx.cleanup();
		}
	});
});

// ── E10: Edge cases ─────────────────────────────────────────────────────────

describe("E2E — edge cases", () => {
	it("completes with no agent calls", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
return { static: true }`,
			});

			await waitForTask(ctx.taskManager, task.task_id);
			expect(JSON.parse(ctx.taskManager.get(task.task_id)?.result ?? "null")).toEqual({ static: true });
			expect(mock.sessions).toHaveLength(0);
		} finally {
			ctx.cleanup();
		}
	});

	it("passes args to the script", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
return { received: args }`,
				args: { key: "value", num: 42 },
			});

			await waitForTask(ctx.taskManager, task.task_id);
			expect(JSON.parse(ctx.taskManager.get(task.task_id)?.result ?? "null")).toEqual({
				received: { key: "value", num: 42 },
			});
		} finally {
			ctx.cleanup();
		}
	});

	it("saved workflow source works", async () => {
		const mock = createMockSessionFactory({ structuredResult: { ok: true } });
		const ctx = createE2EContext(mock.createSession);
		try {
			ctx.taskManager.putWorkflow(
				"test-wf",
				`export const meta = { name: 'test', description: 'Test' }
return await agent('run', { label: 'r', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } })`,
			);

			const task = ctx.taskManager.create({ source: "saved", workflow_name: "test-wf" });
			await waitForTask(ctx.taskManager, task.task_id);

			const row = ctx.taskManager.get(task.task_id);
			expect(row?.status).toBe("finished");
			expect(row?.workflow_source).toBe("saved");
			expect(row?.workflow_name).toBe("test-wf");
		} finally {
			ctx.cleanup();
		}
	});

	it("generated workflow source works", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({ source: "generated", prompt: "test task" });
			expect(task.generated).toBe(true);

			await waitForTask(ctx.taskManager, task.task_id);
			expect(ctx.taskManager.get(task.task_id)?.status).toBe("finished");
		} finally {
			ctx.cleanup();
		}
	});
});

// ── E7: Worktree isolation ──────────────────────────────────────────────────

// ── E10: Snapshot real-time progress ────────────────────────────────────────

describe("E2E — snapshot", () => {
	it("snapshot tracks agent lifecycle via events", async () => {
		let callCount = 0;
		const mock = createMockSessionFactory({
			handler: () => ({ type: "text", text: `result-${++callCount}` }),
		});
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'snap-test', description: 'Test snapshot' }
phase('Research')
await agent('find info', { label: 'researcher' })
phase('Build')
await agent('implement', { label: 'developer' })
return 'done'`,
			});

			await waitForTask(ctx.taskManager, task.task_id);

			const snap = ctx.taskManager.getSnapshot(task.task_id);
			expect(snap).not.toBeNull();
			expect(snap!.name).toBe("snap-test");
			expect(snap!.agents).toHaveLength(2);
			expect(snap!.agents[0].label).toBe("researcher");
			expect(snap!.agents[0].status).toBe("done");
			expect(snap!.agents[1].label).toBe("developer");
			expect(snap!.agents[1].status).toBe("done");
			expect(snap!.doneCount).toBe(2);
			expect(snap!.runningCount).toBe(0);
			expect(snap!.phases).toContain("Research");
			expect(snap!.phases).toContain("Build");
			expect(snap!.graph.nodes).toContainEqual(
				expect.objectContaining({ id: "phase:research", kind: "phase", status: "done" }),
			);
			expect(snap!.graph.nodes).toContainEqual(
				expect.objectContaining({ id: "agent:2", kind: "agent", label: "developer", status: "done" }),
			);
		} finally {
			ctx.cleanup();
		}
	});

	it("GET /tasks/:id/snapshot returns snapshot", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'api-test', description: 'Test' }
return await agent('work', { label: 'worker' })`,
			});

			await waitForTask(ctx.taskManager, task.task_id);

			const res = await ctx.app.request(`/tasks/${task.task_id}/snapshot`);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.snapshot.name).toBe("api-test");
			expect(body.snapshot.agents).toHaveLength(1);
			expect(body.snapshot.graph.nodes).toContainEqual(
				expect.objectContaining({ id: "agent:1", kind: "agent", label: "worker", status: "done" }),
			);

			const graphRes = await ctx.app.request(`/tasks/${task.task_id}/graph`);
			expect(graphRes.status).toBe(200);
			const graphBody = await graphRes.json();
			expect(graphBody.graph.nodes).toContainEqual(
				expect.objectContaining({ id: "agent:1", kind: "agent", label: "worker", status: "done" }),
			);
		} finally {
			ctx.cleanup();
		}
	});

	it("GET /tasks/:id/snapshot returns 404 for unknown task", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createE2EContext(mock.createSession);
		try {
			const res = await ctx.app.request("/tasks/T-9999/snapshot");
			expect(res.status).toBe(404);
			const graphRes = await ctx.app.request("/tasks/T-9999/graph");
			expect(graphRes.status).toBe(404);
		} finally {
			ctx.cleanup();
		}
	});

	it("snapshot tracks parallel agents correctly", async () => {
		let callCount = 0;
		const mock = createMockSessionFactory({
			handler: () => ({ type: "text", text: `r-${++callCount}` }),
		});
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'parallel-snap', description: 'Test' }
await parallel([
  () => agent('task A', { label: 'alpha' }),
  () => agent('task B', { label: 'beta' }),
  () => agent('task C', { label: 'gamma' }),
])
return 'done'`,
			});

			await waitForTask(ctx.taskManager, task.task_id);

			const snap = ctx.taskManager.getSnapshot(task.task_id);
			expect(snap!.agents).toHaveLength(3);
			expect(snap!.doneCount).toBe(3);
			expect(snap!.runningCount).toBe(0);
			expect(snap!.errorCount).toBe(0);
		} finally {
			ctx.cleanup();
		}
	});

	it("snapshot tracks agent failure as error", async () => {
		const mock = createMockSessionFactory({ error: new Error("LLM failed") });
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'fail-snap', description: 'Test' }
const r = await agent('will fail', { label: 'broken' })
return { r }`,
			});

			await waitForTask(ctx.taskManager, task.task_id, "failed", 5000);

			const snap = ctx.taskManager.getSnapshot(task.task_id);
			expect(snap).not.toBeNull();
			expect(snap!.agents).toHaveLength(1);
			expect(snap!.agents[0].status).toBe("error");
			expect(snap!.errorCount).toBe(1);
		} finally {
			ctx.cleanup();
		}
	});
});

// ── E11: CleanupScheduler integration ───────────────────────────────────────

describe("E2E — cleanup scheduler", () => {
	it("CleanupScheduler is created and starts with the server", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createE2EContext(mock.createSession);
		try {
			// Verify the task manager exposes isolationManager for the scheduler
			expect(ctx.taskManager.isolationManager).toBeDefined();
			expect(typeof ctx.taskManager.isolationManager.cleanupStaleWorktrees).toBe("function");
		} finally {
			ctx.cleanup();
		}
	});

	it("cleanup scheduler runs and cleans expired journals", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createE2EContext(mock.createSession);
		try {
			// Create a task to get a journal.db
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
return 'done'`,
			});
			await waitForTask(ctx.taskManager, task.task_id);

			const journalPath = join(ctx.config.paths.runsDir, task.task_id, "journal.db");
			expect(existsSync(journalPath)).toBe(true);

			// Manually run cleanup with 0 retention (delete all journals)
			const { CleanupScheduler } = await import("../../src/server/cleanup-scheduler.ts");
			const cleanupLogger = { info: () => {}, warn: () => {}, error: () => {} };
			const scheduler = new CleanupScheduler({
				config: { ...ctx.config.cleanup, journalRetentionDays: 0 },
				paths: ctx.config.paths,
				isolation: ctx.taskManager.isolationManager,
				logger: cleanupLogger as never,
			});
			const result = await scheduler.run();

			expect(result.journalsCleaned).toBe(1);
			expect(existsSync(journalPath)).toBe(false);
		} finally {
			ctx.cleanup();
		}
	});

	it("cleanup scheduler cleans expired trace directories", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createE2EContext(mock.createSession);
		try {
			// Create old and recent trace dirs
			const oldDir = join(ctx.config.paths.tracesDir, "2020-01-01");
			const recentDate = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
			const recentDir = join(ctx.config.paths.tracesDir, recentDate);
			const { mkdirSync, writeFileSync } = await import("node:fs");
			mkdirSync(oldDir, { recursive: true });
			mkdirSync(recentDir, { recursive: true });
			writeFileSync(join(oldDir, "test.jsonl"), "old");
			writeFileSync(join(recentDir, "test.jsonl"), "recent");

			const { CleanupScheduler } = await import("../../src/server/cleanup-scheduler.ts");
			const cleanupLogger = { info: () => {}, warn: () => {}, error: () => {} };
			const scheduler = new CleanupScheduler({
				config: { ...ctx.config.cleanup, traceRetentionDays: 30 },
				paths: ctx.config.paths,
				isolation: ctx.taskManager.isolationManager,
				logger: cleanupLogger as never,
			});
			const result = await scheduler.run();

			expect(existsSync(oldDir)).toBe(false);
			expect(existsSync(recentDir)).toBe(true);
			expect(result.tracesCleaned).toBe(1);
		} finally {
			ctx.cleanup();
		}
	});
});

// ── E12: Subagent session persistence ────────────────────────────────────────

describe("E2E — subagent session persistence", () => {
	it("persists subagent sessions when persistSubagents is enabled", async () => {
		const mock = createMockSessionFactory({ text: "persisted result" });
		const ctx = createE2EContext(mock.createSession, { persistSubagents: true });
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
return await agent('summarize', { label: 'researcher' })`,
			});

			await waitForTask(ctx.taskManager, task.task_id);
			expect(ctx.taskManager.get(task.task_id)?.status).toBe("finished");

			// Check that session files were created
			const subagentsDir = join(ctx.config.paths.runsDir, task.task_id, "debug", "subagents");
			expect(existsSync(subagentsDir)).toBe(true);
			const labelDir = join(subagentsDir, "researcher");
			expect(existsSync(labelDir)).toBe(true);
			const files = readdirSync(labelDir);
			expect(files).toHaveLength(1);
			expect(files[0]).toMatch(/\.jsonl$/);
		} finally {
			ctx.cleanup();
		}
	});

	it("does not persist when persistSubagents is disabled", async () => {
		const mock = createMockSessionFactory({ text: "result" });
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
return await agent('work', { label: 'worker' })`,
			});

			await waitForTask(ctx.taskManager, task.task_id);

			const subagentsDir = join(ctx.config.paths.runsDir, task.task_id, "debug", "subagents");
			expect(existsSync(subagentsDir)).toBe(false);
		} finally {
			ctx.cleanup();
		}
	});

	it("persists multiple agents with different labels", async () => {
		let callCount = 0;
		const mock = createMockSessionFactory({
			handler: () => ({ type: "text", text: `result-${++callCount}` }),
		});
		const ctx = createE2EContext(mock.createSession, { persistSubagents: true });
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
const a = await agent('task A', { label: 'designer' })
const b = await agent('task B', { label: 'developer' })
return { a, b }`,
			});

			await waitForTask(ctx.taskManager, task.task_id);

			const subagentsDir = join(ctx.config.paths.runsDir, task.task_id, "debug", "subagents");
			expect(existsSync(join(subagentsDir, "designer"))).toBe(true);
			expect(existsSync(join(subagentsDir, "developer"))).toBe(true);
		} finally {
			ctx.cleanup();
		}
	});

	it("persisted session files contain valid JSONL with session header", async () => {
		const mock = createMockSessionFactory({ text: "result" });
		const ctx = createE2EContext(mock.createSession, { persistSubagents: true });
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
return await agent('analyze', { label: 'analyzer' })`,
			});

			await waitForTask(ctx.taskManager, task.task_id);

			const labelDir = join(ctx.config.paths.runsDir, task.task_id, "debug", "subagents", "analyzer");
			const file = readdirSync(labelDir)[0];
			const content = readFileSync(join(labelDir, file), "utf8");
			const lines = content.trim().split("\n");
			expect(lines.length).toBeGreaterThanOrEqual(1);

			// First line is session header
			const header = JSON.parse(lines[0]);
			expect(header.type).toBe("session");
			expect(header.id).toBeDefined();
			expect(header.cwd).toBeDefined();
		} finally {
			ctx.cleanup();
		}
	});

	it("GET /tasks/:id/sessions lists persisted subagent sessions", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createE2EContext(mock.createSession, { persistSubagents: true });
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
await agent('task A', { label: 'alpha' })
await agent('task B', { label: 'beta' })
return 'done'`,
			});

			await waitForTask(ctx.taskManager, task.task_id);

			const res = await ctx.app.request(`/tasks/${task.task_id}/sessions`);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.sessions).toHaveLength(2);
			expect(body.sessions.map((s: { label: string }) => s.label).sort()).toEqual(["alpha", "beta"]);
			for (const session of body.sessions as Array<{ files: string[]; paths: string[] }>) {
				expect(session.files).toHaveLength(1);
				expect(session.paths).toHaveLength(1);
				expect(session.paths[0]).toContain(session.files[0]);
				expect(session.paths[0]).toContain("debug/subagents");
			}
		} finally {
			ctx.cleanup();
		}
	});

	it("GET /tasks/:id/sessions/:label returns session entries", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createE2EContext(mock.createSession, { persistSubagents: true });
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
return await agent('work', { label: 'worker' })`,
			});

			await waitForTask(ctx.taskManager, task.task_id);

			const res = await ctx.app.request(`/tasks/${task.task_id}/sessions/worker`);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.label).toBe("worker");
			expect(body.path).toContain(body.file);
			expect(body.path).toContain("debug/subagents/worker");
			expect(body.entries).toBeDefined();
			expect(body.entries.length).toBeGreaterThanOrEqual(1);
		} finally {
			ctx.cleanup();
		}
	});

	it("GET /tasks/:id/sessions/:label/stream streams persisted session entries", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createE2EContext(mock.createSession, { persistSubagents: true });
		const decoder = new TextDecoder();
		const controller = new AbortController();
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
return await agent('stream work', { label: 'streamer' })`,
			});

			await waitForTask(ctx.taskManager, task.task_id);

			const res = await ctx.app.request(`/tasks/${task.task_id}/sessions/streamer/stream`, {
				signal: controller.signal,
			});
			expect(res.status).toBe(200);
			expect(res.body).toBeDefined();
			const reader = res.body?.getReader();
			let text = "";
			for (let i = 0; i < 5 && reader && !text.includes("session.entry"); i++) {
				const chunk = await Promise.race([
					reader.read(),
					new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) =>
						setTimeout(() => reject(new Error("timed out waiting for session stream")), 1000),
					),
				]);
				if (chunk.done) break;
				text += decoder.decode(chunk.value, { stream: true });
			}
			controller.abort();
			await reader?.cancel().catch(() => {});

			expect(text).toContain("event: session.entry");
			expect(text).toContain("streamer");
			expect(text).toContain("debug/subagents/streamer");
		} finally {
			controller.abort();
			ctx.cleanup();
		}
	});
});

describe("E2E — worktree isolation", () => {
	it("agent with isolation:worktree runs in a worktree cwd", async () => {
		cleanupBranches();
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
return await agent('work in isolation', { label: 'dev', isolation: 'worktree' })`,
			});

			await waitForTask(ctx.taskManager, task.task_id);
			expect(ctx.taskManager.get(task.task_id)?.status).toBe("finished");
			expect(mock.sessions).toHaveLength(1);
		} finally {
			ctx.cleanup();
			cleanupBranches();
		}
	});

	it("multiple agents can use different worktree labels", async () => {
		cleanupBranches();
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
const a = await agent('task A', { label: 'dev', isolation: 'worktree' })
const b = await agent('task B', { label: 'review', isolation: 'worktree' })
return { a, b }`,
			});

			await waitForTask(ctx.taskManager, task.task_id);
			expect(ctx.taskManager.get(task.task_id)?.status).toBe("finished");
			expect(mock.sessions).toHaveLength(2);
		} finally {
			ctx.cleanup();
			cleanupBranches();
		}
	});
});

// ── Worktree preparation commands ───────────────────────────────────────
describe("E2E — worktree preparation commands", () => {
	it("does nothing when no commands are configured", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
return { static: true }`,
				options: { prepare_commands: [] },
			});

			await waitForTask(ctx.taskManager, task.task_id);
			expect(ctx.taskManager.get(task.task_id)?.status).toBe("finished");
			expect(ctx.taskManager.getWorktrees(task.task_id)).toEqual([]);
		} finally {
			ctx.cleanup();
		}
	});

	it("runs successful commands in task worktree", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createE2EContext(mock.createSession);
		try {
			ctx.config.isolation.prepareCommands = ["echo prepared-by-global-config > prep-marker.txt"];

			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
return { static: true }`,
				options: {
					prepare_commands: ["echo prepared-by-task-command >> prep-marker.txt"],
				},
			});

			await waitForTask(ctx.taskManager, task.task_id);
			expect(ctx.taskManager.get(task.task_id)?.status).toBe("finished");

			const worktrees = ctx.taskManager.getWorktrees(task.task_id);
			expect(worktrees).toHaveLength(1);
			const marker = join(worktrees[0].worktree_path, "prep-marker.txt");
			expect(existsSync(marker)).toBe(true);
			expect(readFileSync(marker, "utf8")).toContain("prepared-by-global-config");
			expect(readFileSync(marker, "utf8")).toContain("prepared-by-task-command");
		} finally {
			ctx.cleanup();
			cleanupBranches();
		}
	});

	it("fails task before agent execution when preparation command fails", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createE2EContext(mock.createSession);
		try {
			const command = `node -e 'console.log("prep out"); console.error("prep err"); process.exit(9);'`;
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
return await agent('do work', { label: 'dev', isolation: 'worktree' })`,
				options: { prepare_commands: [command] },
			});

			await waitForTask(ctx.taskManager, task.task_id, "failed", 10_000);
			expect(ctx.taskManager.get(task.task_id)?.error).toContain("Failed to run worktree preparation command");
			expect(ctx.taskManager.get(task.task_id)?.error).toContain("prep out");
			expect(ctx.taskManager.get(task.task_id)?.error).toContain("prep err");
			expect(ctx.taskManager.get(task.task_id)?.error).toContain("Exit code");
			expect(mock.sessions).toHaveLength(0);
		} finally {
			ctx.cleanup();
			cleanupBranches();
		}
	});
});

describe("E2E — worktree cleanup", () => {
	it("task finish keeps worktree dir and branch for inspection", async () => {
		cleanupBranches();
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
return await agent('work', { label: 'dev', isolation: 'worktree' })`,
			});

			await waitForTask(ctx.taskManager, task.task_id);
			expect(ctx.taskManager.get(task.task_id)?.status).toBe("finished");

			// Branch should still exist (kept for merge/reject)
			const branches = execSync("git branch | grep kanade/", { encoding: "utf8", cwd: process.cwd() });
			expect(branches).toContain(`kanade/${task.task_id}`);
		} finally {
			ctx.cleanup();
			cleanupBranches();
		}
	});

	it("task abort preserves worktree dir and branch for recovery", async () => {
		cleanupBranches();
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
await agent('work', { label: 'dev', isolation: 'worktree' })
await request_human({ title: 'wait' })
return 'done'`,
			});

			await waitForTask(ctx.taskManager, task.task_id, "needs_human", 5000);
			await ctx.taskManager.abort(task.task_id);
			await waitForTask(ctx.taskManager, task.task_id, "aborted", 5000);

			// Branch should still exist so interrupted work can be inspected or recovered.
			const branches = execSync("git branch 2>/dev/null | grep 'kanade/X-' || true", {
				encoding: "utf8",
				cwd: process.cwd(),
			});
			expect(branches).toContain(`kanade/${task.task_id}`);
		} finally {
			ctx.cleanup();
			cleanupBranches();
		}
	});
});

// ── E9: reuseBranch ─────────────────────────────────────────────────────────

describe("E2E — reuseBranch", () => {
	it("second agent reuses worktree from first agent via reuseBranch", async () => {
		cleanupBranches();
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createE2EContext(mock.createSession);
		try {
			const task1 = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
return await agent('setup', { label: 'dev', isolation: 'worktree' })`,
			});
			await waitForTask(ctx.taskManager, task1.task_id);
			expect(ctx.taskManager.get(task1.task_id)?.status).toBe("finished");

			const task2 = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
return await agent('iterate', { label: 'dev-v2', isolation: 'worktree', reuseBranch: 'kanade/${task1.task_id}' })`,
			});
			await waitForTask(ctx.taskManager, task2.task_id);
			expect(ctx.taskManager.get(task2.task_id)?.status).toBe("finished");
			expect(mock.sessions).toHaveLength(2);
		} finally {
			ctx.cleanup();
			cleanupBranches();
		}
	});
});

// ── Iterate ────────────────────────────────────────────────────────────────

describe("E2E — iterate", () => {
	it("iterate creates a new task with previousResult", async () => {
		let callCount = 0;
		const mock = createMockSessionFactory({
			handler: () => ({ type: "text", text: `result-${++callCount}` }),
		});
		const ctx = createE2EContext(mock.createSession);
		try {
			const t1 = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
return await agent('initial', { label: 'dev' })`,
			});
			await waitForTask(ctx.taskManager, t1.task_id);

			const t2 = ctx.taskManager.iterate(t1.task_id, { instructions: "improve it" });
			await waitForTask(ctx.taskManager, t2.task_id);

			expect(ctx.taskManager.get(t2.task_id)?.status).toBe("finished");
			expect(t2.task_id).not.toBe(t1.task_id);

			// Check iteration chain
			const iter = ctx.taskManager.getIteration(t2.task_id);
			expect(iter.iteration?.parent_task_id).toBe(t1.task_id);
			expect(iter.iteration?.instructions).toBe("improve it");
			expect(iter.chain).toEqual([t1.task_id, t2.task_id]);
		} finally {
			ctx.cleanup();
		}
	});
});

// ── E10: abort during execution ─────────────────────────────────────────────

describe("E2E — abort mid-execution", () => {
	it("abort signal propagates to running agent", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
return await agent('long task', { label: 'worker' })`,
			});

			await ctx.taskManager.abort(task.task_id);
			await waitForTask(ctx.taskManager, task.task_id, "aborted", 5000);
			expect(ctx.taskManager.get(task.task_id)?.status).toBe("aborted");
		} finally {
			ctx.cleanup();
		}
	});

	it("abort stops parallel agents after human gate", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
await request_human({ title: 'wait' })
await parallel([
  () => agent('a', { label: 'a' }),
  () => agent('b', { label: 'b' }),
])
return 'done'`,
			});

			await waitForTask(ctx.taskManager, task.task_id, "needs_human", 5000);
			await ctx.taskManager.abort(task.task_id);
			await waitForTask(ctx.taskManager, task.task_id, "aborted", 5000);
			expect(ctx.taskManager.get(task.task_id)?.status).toBe("aborted");
		} finally {
			ctx.cleanup();
		}
	});
});

// ── E11: token budget ───────────────────────────────────────────────────────

describe("E2E — token budget", () => {
	it("workflow fails when token budget exhausted", async () => {
		const mock = createMockSessionFactory({ text: "x" });
		const ctx = createE2EContext(mock.createSession);
		try {
			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
for (let i = 0; i < 10; i++) {
  await agent('work ' + i, { label: 'w' + i })
}
return 'done'`,
				options: { token_budget: 5 },
			});

			await waitForTask(ctx.taskManager, task.task_id, "failed", 10000);
			const row = ctx.taskManager.get(task.task_id);
			expect(row?.status).toBe("failed");
			expect(row?.error).toContain("budget");
		} finally {
			ctx.cleanup();
		}
	});
});

// ── E16: parallel event interleaving ─────────────────────────────────────────

describe("E2E — parallel event interleaving", () => {
	it("parallel agents emit correct started/completed pairs", async () => {
		let callCount = 0;
		const mock = createMockSessionFactory({
			handler: () => ({ type: "text", text: `r-${++callCount}` }),
		});
		const ctx = createE2EContext(mock.createSession);
		try {
			const started: string[] = [];
			const completed: string[] = [];
			ctx.events.onAny((e) => {
				if (e.type === "workflow.agent_started") started.push((e.data as { label: string }).label);
				if (e.type === "workflow.agent_completed") completed.push((e.data as { label: string }).label);
			});

			const task = ctx.taskManager.create({
				source: "inline",
				script: `export const meta = { name: 'test', description: 'Test' }
await parallel([
  () => agent('task A', { label: 'alpha' }),
  () => agent('task B', { label: 'beta' }),
  () => agent('task C', { label: 'gamma' }),
])
return 'done'`,
			});

			await waitForTask(ctx.taskManager, task.task_id);

			expect(started).toHaveLength(3);
			expect(completed).toHaveLength(3);
			expect(started.sort()).toEqual(["alpha", "beta", "gamma"]);
			expect(completed.sort()).toEqual(["alpha", "beta", "gamma"]);
		} finally {
			ctx.cleanup();
		}
	});
});
