/**
 * Eval framework types.
 *
 * EvalCase defines a test scenario with expected outcomes and scoring weights.
 * EvalResult captures the actual outcome and computed score.
 */

export type EvalCategory = "bugfix" | "research" | "refactor" | "feature" | "code_review";

export interface EvalCase {
	id: string;
	name: string;
	category: EvalCategory;
	/** Source type: inline script, saved workflow, or generated from prompt */
	source: "inline" | "saved" | "generated";
	/** Inline script content (required when source=inline) */
	script?: string;
	/** Saved workflow name (required when source=saved) */
	workflow_name?: string;
	/** Prompt for generated mode (required when source=generated) */
	prompt?: string;
	/** Arguments passed to the workflow */
	args?: unknown;

	expected: {
		/** Expected final task status */
		status: "finished" | "needs_human";
		/** Result should contain these fields (deep partial match) */
		resultContains?: unknown;
		/** Maximum allowed agent calls */
		maxAgentCalls?: number;
		/** Maximum execution time in ms */
		maxDurationMs?: number;
		/** Maximum token consumption */
		maxTokens?: number;
		/** These phase names must appear */
		requiredPhases?: string[];
	};

	scoring: {
		weights: {
			/** Weight for task completion (0-1) */
			completion: number;
			/** Weight for result correctness (0-1) */
			correctness: number;
			/** Weight for efficiency — agent calls, time, tokens (0-1) */
			efficiency: number;
		};
	};
}

export interface RunMetrics {
	agentCalls: number;
	durationMs: number;
	tokensUsed: number;
	journalHits: number;
	phases: string[];
}

export interface EvalResult {
	caseId: string;
	caseName: string;
	category: EvalCategory;
	passed: boolean;
	score: number;
	breakdown: {
		completion: number;
		correctness: number;
		efficiency: number;
	};
	metrics: RunMetrics;
	actualStatus: string;
	error?: string;
}

export interface EvalReport {
	timestamp: string;
	total: number;
	passed: number;
	failed: number;
	avgScore: number;
	results: EvalResult[];
	byCategory: Record<string, { total: number; passed: number; avgScore: number }>;
}
