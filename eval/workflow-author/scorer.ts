import type { Node } from "acorn";
import { parse } from "acorn";
import type { AuthorEvalCase } from "./cases.ts";
import type { PromptVariant } from "./prompts.ts";

export interface AuthorEvalResult {
	caseId: string;
	caseName: string;
	model: string;
	variant: PromptVariant;
	score: number;
	passed: boolean;
	metrics: AuthorEvalMetrics;
	notes: string[];
	script: string;
}

export interface AuthorEvalMetrics {
	workflowSize: "small" | "medium" | "large";
	primarySteps: number;
	agentCountEstimate: number;
	lowLevelControlCount: number;
	usesKinds: string[];
	hasReview: boolean;
	hasTest: boolean;
	hasHumanGate: boolean;
	usesParallel: boolean;
	usesRawAgent: boolean;
	usesRawPipeline: boolean;
	workflowSizeFit: boolean;
	projectAgnostic: boolean;
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
] as const;

const RAW_API_CALL_NAMES = ["agent", "pipeline"] as const;
const EXTRA_SIGNAL_CALL_NAMES = ["parallel"] as const;
const WORKFLOW_CALL_NAMES = new Set<string>([...KNOWN_KINDS, ...RAW_API_CALL_NAMES, ...EXTRA_SIGNAL_CALL_NAMES]);
const LOW_LEVEL_OPTION_KEYS = new Set(["isolation", "reuseBranch", "agentType", "branch", "command", "testCommand"]);
const ITERATE_ARG_KEYS = new Set(["instructions", "previousResult", "previousTaskId", "reuseBranch"]);

interface ValidationPolicy {
	allowedCommandHints: RegExp[];
	disallowNodeDefaults?: RegExp[];
	requiredFallbackTerms?: RegExp[];
}

const GENERIC_FALLBACK_TERMS = [/\brelevant project checks\b/i, /run.*validation/i, /run relevant/i, /run the checks/i];
const STACK_VALIDATION_POLICIES: Record<string, ValidationPolicy> = {
	node: {
		allowedCommandHints: [/\bnpm\b/i, /\bnpx\b/i, /\byarn\b/i, /\bpnpm\b/i, /\bnpm run\b/i, /\btypecheck\b/i],
	},
	"java-maven": {
		allowedCommandHints: [/\b(?:\.\/)?mvnw?(?:\s+test)?\b/i, /\bmvn\s+(?:-q\s+)?test\b/i],
		disallowNodeDefaults: [/\bnpm\b/i, /\bnpx\b/i, /\byarn\b/i, /\bpnpm\b/i, /\btypecheck\b/i],
		requiredFallbackTerms: [
			/inspected/i,
			/no (?:automated|reliable|clear) (?:command|checks?)/i,
			/inspect(ed|ing) (?:pom\.xml|build|README|docs?)/i,
		],
	},
	"java-gradle": {
		allowedCommandHints: [/\b(?:\.\/)?gradlew\b/i, /\bgradle\b/i, /\bgradlew\s+test\b/i],
		disallowNodeDefaults: [/\bnpm\b/i, /\bnpx\b/i, /\byarn\b/i, /\bpnpm\b/i, /\btypecheck\b/i],
		requiredFallbackTerms: [
			/inspected/i,
			/no (?:automated|reliable|clear) (?:command|checks?)/i,
			/inspect(ed|ing) (?:build\.gradle|gradle\.kts|README|docs?)/i,
		],
	},
	python: {
		allowedCommandHints: [/\bpytest\b/i, /\bpython -m pytest\b/i],
		disallowNodeDefaults: [/\bnpm\b/i, /\bnpx\b/i, /\byarn\b/i, /\bpnpm\b/i, /\btypecheck\b/i],
		requiredFallbackTerms: [
			/inspected/i,
			/no (?:automated|reliable|clear) (?:command|checks?)/i,
			/inspect(ed|ing) (?:requirements\.txt|pyproject\.toml|tests?)\b/i,
		],
	},
	go: {
		allowedCommandHints: [/\bgo\s+test\b/i],
		disallowNodeDefaults: [/\bnpm\b/i, /\bnpx\b/i, /\byarn\b/i, /\bpnpm\b/i, /\btypecheck\b/i],
		requiredFallbackTerms: [
			/inspected/i,
			/no (?:automated|reliable|clear) (?:command|checks?)/i,
			/inspect(ed|ing) (?:go\.mod|README|docs?)/i,
		],
	},
	rust: {
		allowedCommandHints: [/\bcargo\s+test\b/i],
		disallowNodeDefaults: [/\bnpm\b/i, /\bnpx\b/i, /\byarn\b/i, /\bpnpm\b/i, /\btypecheck\b/i],
		requiredFallbackTerms: [
			/inspected/i,
			/no (?:automated|reliable|clear) (?:command|checks?)/i,
			/inspect(ed|ing) (?:Cargo\.toml|README|docs?)/i,
		],
	},
	"docs-only": {
		allowedCommandHints: [/\bmarkdownlint\b/i, /\bvale\b/i, /\bmake\s+docs?-?check\b/i],
		disallowNodeDefaults: [
			/\bnpm\b/i,
			/\bnpx\b/i,
			/\byarn\b/i,
			/\bpnpm\b/i,
			/\btypecheck\b/i,
			/\b(?:\.\/)?mvnw?\b/i,
			/\bgradle(?:w)?\b/i,
			/\bpytest\b/i,
			/\bcargo\s+test\b/i,
			/\bgo\s+test\b/i,
		],
		requiredFallbackTerms: [
			/docs?-only/i,
			/markdown/i,
			/links?\/?formatting/i,
			/no (?:automated|reliable|clear) (?:command|checks?)/i,
		],
	},
};

type AnyNode = Node & {
	type: string;
	[key: string]: unknown;
};

interface ScriptSignals {
	callCounts: Map<string, number>;
	lowLevelControlCount: number;
	iterateArgAccessCount: number;
	workflowGuidance: string[];
}

export function scoreAuthorOutput(input: {
	evalCase: AuthorEvalCase;
	variant: PromptVariant;
	script: string;
	model?: string;
}): AuthorEvalResult {
	const notes: string[] = [];
	let score = 1;

	const signals = analyzeScriptStructure(input.script);
	const usesKinds = KNOWN_KINDS.filter((kind) => (signals.callCounts.get(kind) ?? 0) > 0);
	const primarySteps = usesKinds.filter((kind) => kind !== "request_human").length;
	const agentCountEstimate = estimateAgentCount(signals);
	const lowLevelControlCount = signals.lowLevelControlCount;
	const hasReview = (signals.callCounts.get("reviewChange") ?? 0) > 0;
	const hasTest = (signals.callCounts.get("testChange") ?? 0) > 0;
	const hasHumanGate = (signals.callCounts.get("request_human") ?? 0) > 0;
	const usesParallel = (signals.callCounts.get("parallel") ?? 0) > 0;
	const usesRawAgent = (signals.callCounts.get("agent") ?? 0) > 0;
	const usesRawPipeline = (signals.callCounts.get("pipeline") ?? 0) > 0;
	const workflowSizeFit = evaluateWorkflowSizeFit(input.evalCase.workflowSize, {
		primarySteps,
		agentCountEstimate,
		hasReview,
		hasTest,
		hasHumanGate,
		usesParallel,
		usesKinds,
	});
	const projectAgnostic = evaluateProjectAgnostic(input.evalCase.projectStack, signals.workflowGuidance);

	if (!workflowSizeFit) {
		score -= 0.12;
		notes.push(`workflow size mismatch for ${input.evalCase.workflowSize} case`);
	}

	if (!projectAgnostic) {
		score -= 0.12;
		notes.push(`validation guidance is not project-appropriate for ${input.evalCase.projectStack ?? "unknown"}`);
	}

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

	const guidanceText = signals.workflowGuidance.join("\n");
	const validationSignal = scoreValidationGuidance(input.evalCase.projectStack, signals.workflowGuidance);
	score += validationSignal.delta;
	notes.push(...validationSignal.notes);

	for (const requiredPattern of input.evalCase.expectations.requiredGuidancePatterns ?? []) {
		if (!requiredPattern.test(guidanceText)) {
			score -= 0.18;
			notes.push(`missing required guidance pattern: ${requiredPattern}`);
		}
	}

	for (const forbiddenPattern of input.evalCase.expectations.forbiddenGuidancePatterns ?? []) {
		if (forbiddenPattern.test(guidanceText)) {
			score -= 0.2;
			notes.push(`uses forbidden guidance pattern: ${forbiddenPattern}`);
		}
	}

	if (input.evalCase.expectations.requiresHumanGate && !hasHumanGate) {
		score -= 0.18;
		notes.push("missing human gate for risky/ambiguous task");
	}

	if (input.variant === "semantic-no-read") {
		if (!usesKinds.length) {
			score -= 0.25;
			notes.push("semantic prompt did not use semantic step helpers");
		}
		for (const rawCallName of RAW_API_CALL_NAMES) {
			if ((signals.callCounts.get(rawCallName) ?? 0) > 0) {
				score -= 0.15;
				notes.push(`semantic prompt fell back to raw ${rawCallName}() API`);
			}
		}
		if (signals.iterateArgAccessCount > 0) {
			score -= 0.12;
			notes.push("semantic prompt authored a custom iterate branch instead of staying on the generated-task path");
		}
	}

	if (input.variant === "current-no-read") {
		if ((signals.callCounts.get("agent") ?? 0) > 0 && lowLevelControlCount === 0) {
			notes.push("current prompt stayed relatively high-level despite raw agent API");
		}
	}

	const normalized = Math.max(0, Math.min(1, Number(score.toFixed(3))));
	return {
		caseId: input.evalCase.id,
		caseName: input.evalCase.name,
		model: input.model ?? "default",
		variant: input.variant,
		score: normalized,
		passed: normalized >= 0.7,
		metrics: {
			workflowSize: input.evalCase.workflowSize,
			primarySteps,
			agentCountEstimate,
			lowLevelControlCount,
			usesKinds: [...usesKinds],
			hasReview,
			hasTest,
			hasHumanGate,
			usesParallel,
			usesRawAgent,
			usesRawPipeline,
			workflowSizeFit,
			projectAgnostic,
		},
		notes,
		script: input.script,
	};
}

function estimateAgentCount(signals: ScriptSignals): number {
	return [...KNOWN_KINDS, ...RAW_API_CALL_NAMES].reduce((sum, kind) => sum + (signals.callCounts.get(kind) ?? 0), 0);
}

function evaluateWorkflowSizeFit(
	workflowSize: AuthorEvalCase["workflowSize"],
	metrics: Pick<
		AuthorEvalMetrics,
		"primarySteps" | "agentCountEstimate" | "hasReview" | "hasTest" | "hasHumanGate" | "usesParallel"
	> & {
		usesKinds: string[];
	},
): boolean {
	if (workflowSize === "small") {
		return (
			metrics.primarySteps >= 1 &&
			metrics.primarySteps <= 2 &&
			metrics.agentCountEstimate <= 2 &&
			!metrics.hasReview &&
			!metrics.hasHumanGate &&
			!metrics.usesParallel &&
			!metrics.usesKinds.includes("analyze") &&
			!metrics.usesKinds.includes("continueImplementation")
		);
	}

	if (workflowSize === "medium") {
		return metrics.primarySteps >= 2 && metrics.primarySteps <= 4 && metrics.agentCountEstimate <= 5;
	}

	return metrics.primarySteps >= 2 && metrics.primarySteps <= 6 && metrics.agentCountEstimate <= 8;
}

function evaluateProjectAgnostic(stack: AuthorEvalCase["projectStack"], guidanceTexts: string[]): boolean {
	if (!stack || stack === "node") return true;
	const policy = STACK_VALIDATION_POLICIES[stack as keyof typeof STACK_VALIDATION_POLICIES];
	if (!policy?.disallowNodeDefaults?.length) return true;
	const joinedGuidance = guidanceTexts.join("\n");
	return !policy.disallowNodeDefaults.some((pattern) => pattern.test(joinedGuidance));
}

function analyzeScriptStructure(script: string): ScriptSignals {
	const signals: ScriptSignals = {
		callCounts: new Map<string, number>(),
		lowLevelControlCount: 0,
		iterateArgAccessCount: 0,
		workflowGuidance: [],
	};

	try {
		const normalizedScript = script.replace(/export\s+const\s+meta\b/, "const meta");
		const wrappedScript = `async function __workflow__() {\n${normalizedScript}\n}`;
		const ast = parse(wrappedScript, { ecmaVersion: "latest", sourceType: "script" }) as unknown as AnyNode;
		walkAst(ast, undefined, (node) => {
			if (node.type === "CallExpression") {
				const callName = getCalleeName(node.callee);
				if (callName && WORKFLOW_CALL_NAMES.has(callName)) {
					signals.callCounts.set(callName, (signals.callCounts.get(callName) ?? 0) + 1);
					const args = Array.isArray(node.arguments) ? node.arguments : [];
					const optionsArg = args[1];
					signals.lowLevelControlCount += countLowLevelOptionKeys(optionsArg);
					signals.workflowGuidance.push(...extractTextValues(args[0]), ...extractGuidanceTexts(optionsArg));
				}
			}

			if (node.type === "MemberExpression") {
				const objectName = getIdentifierName(node.object);
				const propertyName = getPropertyName(node.property, Boolean(node.computed));
				if (objectName === "args" && propertyName && ITERATE_ARG_KEYS.has(propertyName)) {
					signals.iterateArgAccessCount += 1;
				}
			}
		});
	} catch {
		// Ignore parse failures and fall back to zero counts; valid workflows should parse.
	}

	return signals;
}

function scoreValidationGuidance(
	stack: AuthorEvalCase["projectStack"],
	guidanceTexts: string[],
): {
	delta: number;
	notes: string[];
} {
	if (!stack) {
		return { delta: 0, notes: [] };
	}

	const policy = STACK_VALIDATION_POLICIES[stack as keyof typeof STACK_VALIDATION_POLICIES];
	if (!policy) {
		return { delta: 0, notes: [] };
	}

	const joinedGuidance = guidanceTexts.join("\n").toLowerCase();
	const hasAllowedCommand = policy.allowedCommandHints.some((pattern) => pattern.test(joinedGuidance));
	const hasDisallowedNodeDefaults =
		stack !== "node" && (policy.disallowNodeDefaults ?? []).some((pattern) => pattern.test(joinedGuidance));
	const hasGenericFallback = GENERIC_FALLBACK_TERMS.some((pattern) => pattern.test(joinedGuidance));
	const hasRequiredFallbackTerms = (policy.requiredFallbackTerms ?? []).some((pattern) => pattern.test(joinedGuidance));

	let delta = 0;
	const notes: string[] = [];

	if (stack !== "node" && !hasAllowedCommand && !hasGenericFallback && !hasRequiredFallbackTerms) {
		delta -= 0.2;
		notes.push("validation guidance did not include project command guidance or fallback rationale");
	}

	if (stack !== "node" && hasAllowedCommand) {
		delta += 0.08;
		notes.push(`validation guidance uses project-appropriate command for ${stack}`);
	}

	if (stack !== "node" && hasDisallowedNodeDefaults) {
		delta -= 0.22;
		notes.push(`validation guidance used Node defaults for non-${stack} case`);
	}

	if (stack !== "node" && hasGenericFallback && !hasAllowedCommand) {
		delta += 0.03;
		if (!hasRequiredFallbackTerms) {
			delta -= 0.08;
			notes.push("fallback validation guidance lacked inspected context or explicit no-command rationale");
		}
	}

	if (stack === "node" && hasAllowedCommand) {
		delta += 0.03;
	}

	return { delta: Number(delta.toFixed(3)), notes };
}

function extractGuidanceTexts(node: unknown): string[] {
	if (!isAstNode(node) || node.type !== "ObjectExpression" || !Array.isArray(node.properties)) return [];
	const values: string[] = [];
	for (const property of node.properties) {
		if (!isAstNode(property) || property.type !== "Property") continue;
		if (getPropertyName(property.key, Boolean(property.computed)) !== "guidance") continue;
		if (!isAstNode(property.value)) continue;
		values.push(...extractTextValues(property.value));
	}
	return values;
}

function extractTextValues(node: unknown): string[] {
	if (!isAstNode(node)) return [];
	if (node.type === "Literal" && typeof node.value === "string") return [node.value];
	if (node.type === "TemplateLiteral" && Array.isArray(node.quasis)) {
		return [
			node.quasis
				.map((q) => {
					const value = (q as { value?: { cooked?: string; raw?: string } }).value;
					if (value?.cooked) return value.cooked;
					return value?.raw ?? "";
				})
				.join(""),
		];
	}
	if (node.type === "BinaryExpression" && node.operator === "+") {
		return [...extractTextValues(node.left), ...extractTextValues(node.right)];
	}
	return [];
}

function walkAst(node: unknown, parent: AnyNode | undefined, visit: (node: AnyNode, parent?: AnyNode) => void): void {
	if (!isAstNode(node)) return;
	visit(node, parent);
	for (const [key, value] of Object.entries(node)) {
		if (key === "start" || key === "end" || key === "loc") continue;
		if (Array.isArray(value)) {
			for (const item of value) walkAst(item, node, visit);
			continue;
		}
		walkAst(value, node, visit);
	}
}

function isAstNode(value: unknown): value is AnyNode {
	return !!value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}

function getCalleeName(callee: unknown): string | null {
	if (!isAstNode(callee)) return null;
	if (callee.type === "Identifier" && typeof callee.name === "string") return callee.name;
	if (callee.type === "ChainExpression") return getCalleeName(callee.expression);
	return null;
}

function getIdentifierName(node: unknown): string | null {
	if (!isAstNode(node)) return null;
	if (node.type === "Identifier" && typeof node.name === "string") return node.name;
	if (node.type === "ChainExpression") return getIdentifierName(node.expression);
	return null;
}

function getPropertyName(node: unknown, computed: boolean): string | null {
	if (!isAstNode(node)) return null;
	if (!computed && node.type === "Identifier" && typeof node.name === "string") return node.name;
	if (node.type === "Literal" && typeof node.value === "string") return node.value;
	return null;
}

function countLowLevelOptionKeys(node: unknown): number {
	if (!isAstNode(node) || node.type !== "ObjectExpression" || !Array.isArray(node.properties)) return 0;
	let count = 0;
	for (const property of node.properties) {
		if (!isAstNode(property) || property.type !== "Property") continue;
		const name = getPropertyName(property.key, Boolean(property.computed));
		if (name && LOW_LEVEL_OPTION_KEYS.has(name)) count += 1;
	}
	return count;
}
