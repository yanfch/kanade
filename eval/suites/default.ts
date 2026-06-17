/**
 * Default eval suite — 10 cases covering basic workflow capabilities.
 *
 * Run with mock session (no real LLM needed):
 *   npx tsx eval/run.ts --mock
 *
 * Run with real LLM:
 *   npx tsx eval/run.ts
 */

import type { EvalCase } from "../types.ts";

const schema = {
	type: "object",
	properties: { ok: { type: "boolean" } },
	required: ["ok"],
};

export const DEFAULT_SUITE: EvalCase[] = [
	// ── Bugfix ───────────────────────────────────────────────────────────
	{
		id: "E001",
		name: "single agent structured output",
		category: "bugfix",
		source: "inline",
		script: `export const meta = { name: 'test', description: 'Simple return' }
const r = await agent('return {ok:true}', { label: 'fix', schema: ${JSON.stringify(schema)} })
return r`,
		expected: {
			status: "finished",
			resultContains: { ok: true },
			maxAgentCalls: 1,
			maxDurationMs: 30_000,
		},
		scoring: { weights: { completion: 0.3, correctness: 0.5, efficiency: 0.2 } },
	},

	{
		id: "E002",
		name: "agent failure fails task",
		category: "bugfix",
		source: "inline",
		script: `export const meta = { name: 'test', description: 'Failure test' }
await agent('fail', { label: 'broken' })
return { unreachable: true }`,
		expected: {
			status: "failed",
			maxAgentCalls: 1,
		},
		scoring: { weights: { completion: 0.4, correctness: 0.4, efficiency: 0.2 } },
	},

	// ── Research ──────────────────────────────────────────────────────────
	{
		id: "E003",
		name: "parallel fan-out 3",
		category: "research",
		source: "inline",
		script: `export const meta = { name: 'fanout', description: 'Fan-out test' }
const results = await parallel(['a','b','c'].map(item => () => agent('process ' + item, { label: item })))
return { count: results.length, items: results }`,
		expected: {
			status: "finished",
			resultContains: { count: 3 },
			maxAgentCalls: 3,
			maxDurationMs: 30_000,
		},
		scoring: { weights: { completion: 0.3, correctness: 0.4, efficiency: 0.3 } },
	},

	{
		id: "E004",
		name: "pipeline through stages",
		category: "research",
		source: "inline",
		script: `export const meta = { name: 'pipeline', description: 'Pipeline test' }
const results = await pipeline(['x', 'y', 'z'], async (item) => agent('process ' + item, { label: item }))
return { count: results.length }`,
		expected: {
			status: "finished",
			resultContains: { count: 3 },
			maxAgentCalls: 3,
		},
		scoring: { weights: { completion: 0.3, correctness: 0.4, efficiency: 0.3 } },
	},

	// ── Refactor ──────────────────────────────────────────────────────────
	{
		id: "E005",
		name: "multi-phase workflow",
		category: "refactor",
		source: "inline",
		script: `export const meta = { name: 'multi', description: 'Multi-phase' }
phase('Research')
await agent('find info', { label: 'researcher' })
phase('Build')
await agent('implement', { label: 'developer' })
phase('Test')
await agent('verify', { label: 'tester' })
return { done: true }`,
		expected: {
			status: "finished",
			resultContains: { done: true },
			requiredPhases: ["Research", "Build", "Test"],
			maxAgentCalls: 3,
		},
		scoring: { weights: { completion: 0.2, correctness: 0.6, efficiency: 0.2 } },
	},

	{
		id: "E006",
		name: "cache_lead parallel",
		category: "refactor",
		source: "inline",
		script: `export const meta = { name: 'cache', description: 'Cache lead test' }
const results = await parallel([
  () => agent('review A', { label: 'a' }),
  () => agent('review B', { label: 'b' }),
  () => agent('review C', { label: 'c' }),
], { cache_lead: true })
return { count: results.length }`,
		expected: {
			status: "finished",
			resultContains: { count: 3 },
			maxAgentCalls: 3,
		},
		scoring: { weights: { completion: 0.3, correctness: 0.4, efficiency: 0.3 } },
	},

	// ── Feature ──────────────────────────────────────────────────────────
	{
		id: "E007",
		name: "args passing",
		category: "feature",
		source: "inline",
		script: `export const meta = { name: 'args', description: 'Args test' }
return { received: args }`,
		args: { key: "value", num: 42 },
		expected: {
			status: "finished",
			resultContains: { received: { key: "value", num: 42 } },
			maxAgentCalls: 0,
		},
		scoring: { weights: { completion: 0.3, correctness: 0.6, efficiency: 0.1 } },
	},

	{
		id: "E008",
		name: "no agent calls",
		category: "feature",
		source: "inline",
		script: `export const meta = { name: 'static', description: 'Static test' }
return { static: true }`,
		expected: {
			status: "finished",
			resultContains: { static: true },
			maxAgentCalls: 0,
		},
		scoring: { weights: { completion: 0.3, correctness: 0.5, efficiency: 0.2 } },
	},

	// ── Code Review ──────────────────────────────────────────────────────
	{
		id: "E009",
		name: "instructions passed to agent",
		category: "code_review",
		source: "inline",
		script: `export const meta = { name: 'instruct', description: 'Instructions test' }
return await agent('summarize', { label: 's', instructions: 'be concise', schema: ${JSON.stringify(schema)} })`,
		expected: {
			status: "finished",
			resultContains: { ok: true },
			maxAgentCalls: 1,
		},
		scoring: { weights: { completion: 0.3, correctness: 0.5, efficiency: 0.2 } },
	},

	{
		id: "E010",
		name: "script throw fails task",
		category: "code_review",
		source: "inline",
		script: `export const meta = { name: 'throw', description: 'Throw test' }
throw new Error('intentional error')`,
		expected: {
			status: "failed",
			maxAgentCalls: 0,
		},
		scoring: { weights: { completion: 0.5, correctness: 0.3, efficiency: 0.2 } },
	},
];
