import type { Node } from "acorn";
import { parse } from "acorn";
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
] as const;

const WORKFLOW_CALL_NAMES = new Set<string>([...KNOWN_KINDS, "agent"]);
const LOW_LEVEL_OPTION_KEYS = new Set(["isolation", "reuseBranch", "agentType", "branch"]);
const ITERATE_ARG_KEYS = new Set(["instructions", "previousResult", "previousTaskId", "reuseBranch"]);

type AnyNode = Node & {
	type: string;
	[key: string]: unknown;
};

interface ScriptSignals {
	callCounts: Map<string, number>;
	lowLevelControlCount: number;
	iterateArgAccessCount: number;
}

export function scoreAuthorOutput(input: {
	evalCase: AuthorEvalCase;
	variant: PromptVariant;
	script: string;
}): AuthorEvalResult {
	const notes: string[] = [];
	let score = 1;

	const signals = analyzeScriptStructure(input.script);
	const usesKinds = KNOWN_KINDS.filter((kind) => (signals.callCounts.get(kind) ?? 0) > 0);
	const primarySteps = usesKinds.filter((kind) => kind !== "request_human").length;
	const lowLevelControlCount = signals.lowLevelControlCount;

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

	const hasHumanGate = (signals.callCounts.get("request_human") ?? 0) > 0;
	if (input.evalCase.expectations.requiresHumanGate && !hasHumanGate) {
		score -= 0.18;
		notes.push("missing human gate for risky/ambiguous task");
	}

	if (input.variant === "semantic-no-read") {
		if (!usesKinds.length) {
			score -= 0.25;
			notes.push("semantic prompt did not use semantic step helpers");
		}
		if ((signals.callCounts.get("agent") ?? 0) > 0) {
			score -= 0.15;
			notes.push("semantic prompt fell back to raw agent() API");
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
		variant: input.variant,
		score: normalized,
		passed: normalized >= 0.7,
		metrics: {
			primarySteps,
			lowLevelControlCount,
			usesKinds: [...usesKinds],
		},
		notes,
		script: input.script,
	};
}

function analyzeScriptStructure(script: string): ScriptSignals {
	const signals: ScriptSignals = {
		callCounts: new Map<string, number>(),
		lowLevelControlCount: 0,
		iterateArgAccessCount: 0,
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
					const optionsArg = Array.isArray(node.arguments) ? node.arguments[1] : undefined;
					signals.lowLevelControlCount += countLowLevelOptionKeys(optionsArg);
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
