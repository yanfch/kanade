import type { AuthorEvalCase } from "./cases.ts";
import type { PromptVariant } from "./prompts.ts";

export interface AuthorEvalResult {
	caseId: string;
	caseName: string;
	variant: PromptVariant;
	score: number;
	passed: boolean;
	metrics: {
		primarySteps: number;
		lowLevelControlCount: number;
		usesKinds: string[];
	};
	notes: string[];
	script: string;
}

const KNOWN_KINDS = [
	"analyze",
	"implement",
	"reviewChange",
	"continueImplementation",
	"compareCandidates",
	"integrateChanges",
	"testChange",
	"summarize",
	"request_human",
];

const LOW_LEVEL_PATTERNS = [
	/isolation\s*:/g,
	/reuseBranch\s*:/g,
	/agentType\s*:/g,
	/worktree/gi,
	/branch\s*:/g,
	/patch transport/gi,
];

export function scoreAuthorOutput(input: {
	evalCase: AuthorEvalCase;
	variant: PromptVariant;
	script: string;
}): AuthorEvalResult {
	const notes: string[] = [];
	let score = 1;

	const usesKinds = KNOWN_KINDS.filter((kind) => new RegExp(`\\b${kind}\\s*\\(`).test(input.script));
	const primarySteps = usesKinds.filter((kind) => kind !== "request_human").length;
	const lowLevelControlCount = LOW_LEVEL_PATTERNS.reduce(
		(sum, pattern) => sum + ((input.script.match(pattern) ?? []).length || 0),
		0,
	);

	if (!/export const meta\s*=\s*\{/.test(input.script)) {
		score -= 0.3;
		notes.push("missing meta export header");
	}

	if (input.evalCase.expectations.preferNoLowLevelControls && lowLevelControlCount > 0) {
		score -= Math.min(0.35, lowLevelControlCount * 0.08);
		notes.push(`uses low-level execution controls (${lowLevelControlCount})`);
	}

	for (const required of input.evalCase.expectations.requiresKinds ?? []) {
		if (!usesKinds.includes(required)) {
			score -= 0.18;
			notes.push(`missing expected step kind: ${required}`);
		}
	}

	for (const forbidden of input.evalCase.expectations.forbidsKinds ?? []) {
		if (usesKinds.includes(forbidden)) {
			score -= 0.2;
			notes.push(`uses forbidden step kind for this case: ${forbidden}`);
		}
	}

	if (
		input.evalCase.expectations.maxPrimarySteps !== undefined &&
		primarySteps > input.evalCase.expectations.maxPrimarySteps
	) {
		score -= Math.min(0.25, (primarySteps - input.evalCase.expectations.maxPrimarySteps) * 0.08);
		notes.push(
			`too many primary steps (${primarySteps}) for expected max ${input.evalCase.expectations.maxPrimarySteps}`,
		);
	}

	if (
		input.evalCase.expectations.minPrimarySteps !== undefined &&
		primarySteps < input.evalCase.expectations.minPrimarySteps
	) {
		score -= 0.2;
		notes.push(
			`too few primary steps (${primarySteps}) for expected min ${input.evalCase.expectations.minPrimarySteps}`,
		);
	}

	const hasHumanGate = /\brequest_human\s*\(/.test(input.script);
	if (input.evalCase.expectations.requiresHumanGate && !hasHumanGate) {
		score -= 0.18;
		notes.push("missing human gate for risky/ambiguous task");
	}

	if (input.variant === "semantic-no-read") {
		if (!usesKinds.length) {
			score -= 0.25;
			notes.push("semantic prompt did not use semantic step helpers");
		}
		if (/\bagent\s*\(/.test(input.script)) {
			score -= 0.15;
			notes.push("semantic prompt fell back to raw agent() API");
		}
		if (/\bargs\??\.(instructions|previousResult|previousTaskId|reuseBranch)\b/.test(input.script)) {
			score -= 0.12;
			notes.push("semantic prompt authored a custom iterate branch instead of staying on the generated-task path");
		}
	}

	if (input.variant === "current-no-read") {
		if (/\bagent\s*\(/.test(input.script) && !/\bisolation\s*:/.test(input.script)) {
			notes.push("current prompt stayed relatively high-level despite raw agent API");
		}
	}

	const normalized = Math.max(0, Math.min(1, Number(score.toFixed(3))));
	return {
		caseId: input.evalCase.id,
		caseName: input.evalCase.name,
		variant: input.variant,
		score: normalized,
		passed: normalized >= 0.7,
		metrics: {
			primarySteps,
			lowLevelControlCount,
			usesKinds,
		},
		notes,
		script: input.script,
	};
}
