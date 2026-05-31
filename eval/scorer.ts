/**
 * Eval scorer — computes completion/correctness/efficiency scores
 * and produces EvalResult from a workflow run.
 */

import type { EvalCase, EvalResult, RunMetrics } from "./types.ts";

/** Deep partial check: does `actual` contain all fields in `expected`? */
function deepContains(actual: unknown, expected: unknown): boolean {
	if (expected === null || expected === undefined) return true;
	if (actual === null || actual === undefined) return false;
	if (typeof expected !== "object") return actual === expected;
	if (typeof actual !== "object") return false;

	const expectedObj = expected as Record<string, unknown>;
	const actualObj = actual as Record<string, unknown>;

	for (const key of Object.keys(expectedObj)) {
		if (!(key in actualObj)) return false;
		if (!deepContains(actualObj[key], expectedObj[key])) return false;
	}
	return true;
}

/** Check that all required phases appear in the actual phases list */
function hasRequiredPhases(actual: string[], required: string[]): boolean {
	return required.every((phase) => actual.includes(phase));
}

/**
 * Score a single eval case against actual workflow result and metrics.
 *
 * Scoring logic:
 * - completion: 1 if actual status matches expected, else 0
 * - correctness: 1 if resultContains matches AND requiredPhases present, else 0
 * - efficiency: worst ratio across maxAgentCalls, maxDurationMs, maxTokens (capped at 1)
 * - score: weighted sum of the three
 * - passed: score >= 0.8
 */
export function scoreCase(
	evalCase: EvalCase,
	actual: { status: string; result: unknown },
	metrics: RunMetrics,
): EvalResult {
	const { expected, scoring } = evalCase;

	// Completion
	const completion = actual.status === expected.status ? 1 : 0;

	// Correctness
	let correctness = 0;
	if (completion === 1) {
		let resultOk = true;
		if (expected.resultContains !== undefined) {
			resultOk = deepContains(actual.result, expected.resultContains);
		}
		let phasesOk = true;
		if (expected.requiredPhases?.length) {
			phasesOk = hasRequiredPhases(metrics.phases, expected.requiredPhases);
		}
		correctness = resultOk && phasesOk ? 1 : 0;
	}

	// Efficiency — worst ratio across all limits (capped at 1)
	let efficiency = 1;
	if (expected.maxAgentCalls && metrics.agentCalls > 0) {
		efficiency = Math.min(efficiency, expected.maxAgentCalls / metrics.agentCalls);
	}
	if (expected.maxDurationMs && metrics.durationMs > 0) {
		efficiency = Math.min(efficiency, expected.maxDurationMs / metrics.durationMs);
	}
	if (expected.maxTokens && metrics.tokensUsed > 0) {
		efficiency = Math.min(efficiency, expected.maxTokens / metrics.tokensUsed);
	}
	efficiency = Math.min(1, efficiency);

	// Weighted score
	const { weights } = scoring;
	const score = completion * weights.completion + correctness * weights.correctness + efficiency * weights.efficiency;

	return {
		caseId: evalCase.id,
		caseName: evalCase.name,
		category: evalCase.category,
		passed: score >= 0.8,
		score: Math.round(score * 1000) / 1000,
		breakdown: { completion, correctness, efficiency },
		metrics,
		actualStatus: actual.status,
	};
}
