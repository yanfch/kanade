import { describe, expect, it } from "vitest";
import { scoreCase } from "./scorer.ts";
import type { EvalCase, RunMetrics } from "./types.ts";

function makeCase(patch: Partial<EvalCase> = {}): EvalCase {
	return {
		id: "T001",
		name: "test case",
		category: "bugfix",
		source: "inline",
		script: "test",
		expected: { status: "finished" },
		scoring: { weights: { completion: 0.3, correctness: 0.5, efficiency: 0.2 } },
		...patch,
	};
}

function makeMetrics(patch: Partial<RunMetrics> = {}): RunMetrics {
	return {
		agentCalls: 1,
		durationMs: 1000,
		tokensUsed: 1000,
		journalHits: 0,
		phases: [],
		...patch,
	};
}

describe("scoreCase", () => {
	it("scores completion=1 when status matches", () => {
		const result = scoreCase(
			makeCase({ expected: { status: "finished" } }),
			{ status: "finished", result: { ok: true } },
			makeMetrics(),
		);
		expect(result.breakdown.completion).toBe(1);
		expect(result.passed).toBe(true);
	});

	it("scores completion=0 when status does not match", () => {
		const result = scoreCase(
			makeCase({ expected: { status: "finished" } }),
			{ status: "failed", result: null },
			makeMetrics(),
		);
		expect(result.breakdown.completion).toBe(0);
		expect(result.passed).toBe(false);
	});

	it("scores correctness=1 when resultContains matches", () => {
		const result = scoreCase(
			makeCase({ expected: { status: "finished", resultContains: { ok: true } } }),
			{ status: "finished", result: { ok: true, extra: "data" } },
			makeMetrics(),
		);
		expect(result.breakdown.correctness).toBe(1);
	});

	it("scores correctness=0 when resultContains does not match", () => {
		const result = scoreCase(
			makeCase({ expected: { status: "finished", resultContains: { ok: true } } }),
			{ status: "finished", result: { ok: false } },
			makeMetrics(),
		);
		expect(result.breakdown.correctness).toBe(0);
	});

	it("scores correctness=0 when completion=0 (no result to check)", () => {
		const result = scoreCase(
			makeCase({ expected: { status: "finished", resultContains: { ok: true } } }),
			{ status: "failed", result: null },
			makeMetrics(),
		);
		expect(result.breakdown.correctness).toBe(0);
	});

	it("scores correctness=1 when no resultContains specified", () => {
		const result = scoreCase(
			makeCase({ expected: { status: "finished" } }),
			{ status: "finished", result: "anything" },
			makeMetrics(),
		);
		expect(result.breakdown.correctness).toBe(1);
	});

	it("scores efficiency=1 when under maxAgentCalls", () => {
		const result = scoreCase(
			makeCase({ expected: { status: "finished", maxAgentCalls: 5 } }),
			{ status: "finished", result: "ok" },
			makeMetrics({ agentCalls: 3 }),
		);
		expect(result.breakdown.efficiency).toBe(1);
	});

	it("scores efficiency<1 when over maxAgentCalls", () => {
		const result = scoreCase(
			makeCase({ expected: { status: "finished", maxAgentCalls: 5 } }),
			{ status: "finished", result: "ok" },
			makeMetrics({ agentCalls: 10 }),
		);
		expect(result.breakdown.efficiency).toBe(0.5);
	});

	it("scores efficiency based on maxDurationMs", () => {
		const result = scoreCase(
			makeCase({ expected: { status: "finished", maxDurationMs: 10_000 } }),
			{ status: "finished", result: "ok" },
			makeMetrics({ durationMs: 20_000 }),
		);
		expect(result.breakdown.efficiency).toBe(0.5);
	});

	it("scores efficiency based on maxTokens", () => {
		const result = scoreCase(
			makeCase({ expected: { status: "finished", maxTokens: 1000 } }),
			{ status: "finished", result: "ok" },
			makeMetrics({ tokensUsed: 2000 }),
		);
		expect(result.breakdown.efficiency).toBe(0.5);
	});

	it("efficiency uses worst ratio across all metrics", () => {
		const result = scoreCase(
			makeCase({
				expected: {
					status: "finished",
					maxAgentCalls: 5,
					maxDurationMs: 10_000,
					maxTokens: 1000,
				},
			}),
			{ status: "finished", result: "ok" },
			makeMetrics({ agentCalls: 3, durationMs: 20_000, tokensUsed: 500 }),
		);
		// duration is worst: 10000/20000 = 0.5
		expect(result.breakdown.efficiency).toBe(0.5);
	});

	it("computes weighted score correctly", () => {
		const result = scoreCase(
			makeCase({
				expected: { status: "finished", resultContains: { ok: true }, maxAgentCalls: 5 },
				scoring: { weights: { completion: 0.3, correctness: 0.5, efficiency: 0.2 } },
			}),
			{ status: "finished", result: { ok: true } },
			makeMetrics({ agentCalls: 3 }),
		);
		// completion=1, correctness=1, efficiency=1
		// score = 1*0.3 + 1*0.5 + 1*0.2 = 1.0
		expect(result.score).toBe(1.0);
		expect(result.passed).toBe(true);
	});

	it("passed=true when score >= 0.8", () => {
		const result = scoreCase(
			makeCase({
				expected: { status: "finished", maxAgentCalls: 5 },
				scoring: { weights: { completion: 0.5, correctness: 0.3, efficiency: 0.2 } },
			}),
			{ status: "finished", result: "ok" },
			makeMetrics({ agentCalls: 10 }),
		);
		// completion=1, correctness=1, efficiency=0.5
		// score = 1*0.5 + 1*0.3 + 0.5*0.2 = 0.9
		expect(result.score).toBe(0.9);
		expect(result.passed).toBe(true);
	});

	it("passed=false when score < 0.8", () => {
		const result = scoreCase(
			makeCase({
				expected: { status: "finished", maxAgentCalls: 5 },
				scoring: { weights: { completion: 0.5, correctness: 0.3, efficiency: 0.2 } },
			}),
			{ status: "finished", result: "ok" },
			makeMetrics({ agentCalls: 50 }),
		);
		// completion=1, correctness=1, efficiency=0.1
		// score = 1*0.5 + 1*0.3 + 0.1*0.2 = 0.82
		expect(result.score).toBeCloseTo(0.82, 2);
		expect(result.passed).toBe(true);
	});

	it("checks requiredPhases", () => {
		const result = scoreCase(
			makeCase({ expected: { status: "finished", requiredPhases: ["Research", "Build"] } }),
			{ status: "finished", result: "ok" },
			makeMetrics({ phases: ["Research", "Build", "Test"] }),
		);
		expect(result.breakdown.correctness).toBe(1);
	});

	it("fails correctness when requiredPhases missing", () => {
		const result = scoreCase(
			makeCase({ expected: { status: "finished", requiredPhases: ["Research", "Deploy"] } }),
			{ status: "finished", result: "ok" },
			makeMetrics({ phases: ["Research", "Build"] }),
		);
		expect(result.breakdown.correctness).toBe(0);
	});

	it("returns correct caseId and caseName", () => {
		const result = scoreCase(
			makeCase({ id: "E001", name: "simple test" }),
			{ status: "finished", result: "ok" },
			makeMetrics(),
		);
		expect(result.caseId).toBe("E001");
		expect(result.caseName).toBe("simple test");
	});
});
