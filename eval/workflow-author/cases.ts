import type { ProjectProfileSnapshot } from "../../src/workspace/project-profile.ts";

export type AuthorCaseComplexity = "simple" | "medium" | "complex";
export type WorkflowSizeHint = "small" | "medium" | "large";

export type WorkflowProjectStack =
	| "node"
	| "java-maven"
	| "java-gradle"
	| "python"
	| "rust"
	| "go"
	| "docs-only"
	| "unknown";

export interface AuthorEvalCase {
	id: string;
	name: string;
	complexity: AuthorCaseComplexity;
	workflowSize: WorkflowSizeHint;
	task: string;
	workspaceBrief: string;
	projectStack?: WorkflowProjectStack;
	projectProfile?: ProjectProfileSnapshot;
	expectations: {
		requiresKinds?: string[];
		forbidsKinds?: string[];
		preferNoLowLevelControls?: boolean;
		maxPrimarySteps?: number;
		minPrimarySteps?: number;
		requiresHumanGate?: boolean;
		requiredGuidancePatterns?: RegExp[];
		forbiddenGuidancePatterns?: RegExp[];
	};
}

function profile(input: {
	root: string;
	detectedStacks: string[];
	indicators?: string[];
	suggestedPrepareCommands?: string[];
	suggestedCheckCommands?: string[];
	summary?: string;
}): ProjectProfileSnapshot {
	return {
		root: input.root,
		detectedStacks: input.detectedStacks,
		indicators: input.indicators ?? [],
		suggestedPrepareCommands: input.suggestedPrepareCommands ?? [],
		suggestedCheckCommands: input.suggestedCheckCommands ?? [],
		summary: input.summary ?? `Detected ${input.detectedStacks.join(", ")} markers at ${input.root}`,
	};
}

const KANADE_WORKSPACE_BRIEF = [
	"Repo: kanade — Node.js + TypeScript multi-agent workflow runtime.",
	"Key areas:",
	"- src/server: HTTP API, task-manager, app routes, workflow author",
	"- src/workflow-engine: runtime, workflow agent, snapshot builder, prompt guidelines",
	"- src/isolation: git worktree isolation",
	"- src/journal: cache key + journal store",
	"- test/e2e-mock: mock E2E tests",
	"Common commands: npm test, npm run typecheck, npm run lint",
	"Iteration policy: kanade iterate uses a separate built-in refine/validate workflow; generated workflows should not author custom iteration branches.",
	"You do NOT have repository read/search tools in this mode. Use only the task brief and this workspace summary.",
].join("\n");

const JAVA_MAVEN_WORKSPACE_BRIEF = [
	"Repo: acme-service — Java Maven backend service.",
	"The repository uses Maven and follows a multi-module layout.",
	"Key areas:",
	"- src/main/java: service and business logic",
	"- src/test/java: unit and integration tests",
	"- pom.xml: module and profile configuration",
	"- test resources: src/test/resources",
	"Common checks: inspect pom.xml and run ./mvnw test (or mvn test if wrapper unavailable).",
	"You do NOT have repository read/search tools in this mode. Use only the task brief and this workspace summary.",
].join("\n");

const JAVA_GRADLE_WORKSPACE_BRIEF = [
	"Repo: billing-worker — Java Gradle service.",
	"The repository uses Gradle with a checked-in wrapper.",
	"Key areas:",
	"- src/main/java: worker and billing logic",
	"- src/test/java: unit tests",
	"- build.gradle.kts and settings.gradle.kts: build configuration",
	"Common checks: inspect Gradle files and run ./gradlew test.",
	"You do NOT have repository read/search tools in this mode. Use only the task brief and this workspace summary.",
].join("\n");

const PYTHON_PYTEST_WORKSPACE_BRIEF = [
	"Repo: analytics-cli — Python utility package.",
	"The repository uses pytest for tests and dependency declarations in requirements.txt.",
	"Key areas:",
	"- src/: application logic",
	"- tests/: unit and integration tests",
	"- requirements.txt: runtime dependencies",
	"- pyproject.toml: packaging and tooling metadata",
	"Common checks: inspect requirements/pyproject and run pytest.",
	"You do NOT have repository read/search tools in this mode. Use only the task brief and this workspace summary.",
].join("\n");

const RUST_WORKSPACE_BRIEF = [
	"Repo: file-indexer — Rust command-line tool.",
	"The repository uses Cargo with unit and integration tests.",
	"Key areas:",
	"- src/: Rust library and CLI implementation",
	"- tests/: integration tests",
	"- Cargo.toml: crate metadata and dependencies",
	"Common checks: run cargo test.",
	"You do NOT have repository read/search tools in this mode. Use only the task brief and this workspace summary.",
].join("\n");

const GO_WORKSPACE_BRIEF = [
	"Repo: webhook-relay — Go service.",
	"The repository uses Go modules.",
	"Key areas:",
	"- cmd/: service entry points",
	"- internal/: implementation packages",
	"- go.mod: module metadata",
	"Common checks: run go test ./...",
	"You do NOT have repository read/search tools in this mode. Use only the task brief and this workspace summary.",
].join("\n");

const DOCS_ONLY_WORKSPACE_BRIEF = [
	"Repo: product-handbook — documentation-only repository.",
	"The repository contains Markdown docs and no application build system.",
	"Key areas:",
	"- docs/: product and operations documentation",
	"- README.md: top-level overview",
	"- CONTRIBUTING.md: writing conventions",
	"Common checks: inspect changed Markdown links and formatting; do not assume npm, Maven, Gradle, pytest, cargo, or go test commands.",
	"You do NOT have repository read/search tools in this mode. Use only the task brief and this workspace summary.",
].join("\n");

const KANADE_NODE_PROFILE = profile({
	root: "/workspace/kanade",
	detectedStacks: ["node"],
	indicators: ["package.json", "package-lock.json", "tsconfig.json"],
	suggestedPrepareCommands: ["npm ci"],
	suggestedCheckCommands: ["npm test"],
});

const MAVEN_PROFILE = profile({
	root: "/workspace/acme-service",
	detectedStacks: ["java-maven"],
	indicators: ["pom.xml", "mvnw", "src/main/java", "src/test/java"],
	suggestedPrepareCommands: ["./mvnw -q -DskipTests dependency:go-offline"],
	suggestedCheckCommands: ["./mvnw test"],
});

const GRADLE_PROFILE = profile({
	root: "/workspace/billing-worker",
	detectedStacks: ["java-gradle"],
	indicators: ["build.gradle.kts", "settings.gradle.kts", "gradlew"],
	suggestedCheckCommands: ["./gradlew test"],
});

const PYTHON_PROFILE = profile({
	root: "/workspace/analytics-cli",
	detectedStacks: ["python"],
	indicators: ["pyproject.toml", "requirements.txt", "tests/"],
	suggestedPrepareCommands: ["python -m pip install -r requirements.txt"],
	suggestedCheckCommands: ["python -m pytest"],
});

const RUST_PROFILE = profile({
	root: "/workspace/file-indexer",
	detectedStacks: ["rust"],
	indicators: ["Cargo.toml", "Cargo.lock", "src/lib.rs"],
	suggestedPrepareCommands: ["cargo fetch"],
	suggestedCheckCommands: ["cargo test"],
});

const GO_PROFILE = profile({
	root: "/workspace/webhook-relay",
	detectedStacks: ["go"],
	indicators: ["go.mod", "go.sum"],
	suggestedPrepareCommands: ["go mod download"],
	suggestedCheckCommands: ["go test ./..."],
});

const DOCS_ONLY_PROFILE = profile({
	root: "/workspace/product-handbook",
	detectedStacks: ["unknown"],
	indicators: ["README.md", "docs/", "CONTRIBUTING.md"],
	suggestedCheckCommands: [],
	summary:
		"No supported project markers were found. This looks documentation-only; do not force language build defaults.",
});

export const AUTHOR_EVAL_CASES: AuthorEvalCase[] = [
	{
		id: "S1",
		name: "single-file bugfix",
		complexity: "simple",
		workflowSize: "small",
		task: "Fix a retry bug in the login flow and add one targeted regression test.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
		projectStack: "node",
		projectProfile: KANADE_NODE_PROFILE,
		expectations: {
			forbidsKinds: [
				"analyze",
				"reviewChange",
				"continueImplementation",
				"compareCandidates",
				"integrateChanges",
				"request_human",
			],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 2,
			minPrimarySteps: 1,
		},
	},
	{
		id: "S2",
		name: "small CLI display tweak",
		complexity: "simple",
		workflowSize: "small",
		task: "Add milliseconds to kanade tail event timestamps and update the relevant CLI tests.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
		projectStack: "node",
		projectProfile: KANADE_NODE_PROFILE,
		expectations: {
			forbidsKinds: [
				"analyze",
				"reviewChange",
				"continueImplementation",
				"compareCandidates",
				"integrateChanges",
				"request_human",
			],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 2,
			minPrimarySteps: 1,
		},
	},
	{
		id: "S3",
		name: "small API tweak with explicit validation",
		complexity: "simple",
		workflowSize: "small",
		task: "Add a small task-detail response field and run the focused app and CLI tests for that change only.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
		projectStack: "node",
		projectProfile: KANADE_NODE_PROFILE,
		expectations: {
			requiresKinds: ["implement", "testChange"],
			forbidsKinds: [
				"analyze",
				"reviewChange",
				"continueImplementation",
				"compareCandidates",
				"integrateChanges",
				"request_human",
			],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 2,
			minPrimarySteps: 2,
		},
	},
	{
		id: "M1",
		name: "medium refactor with review",
		complexity: "medium",
		workflowSize: "medium",
		task: "Refactor workflow author prompt code into a cleaner module structure, keep current behavior, add or update focused tests, and include a reviewer pass after implementation.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
		projectStack: "node",
		projectProfile: KANADE_NODE_PROFILE,
		expectations: {
			requiresKinds: ["implement", "reviewChange"],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 4,
			minPrimarySteps: 2,
		},
	},
	{
		id: "M2",
		name: "cache-key behavior change",
		complexity: "medium",
		workflowSize: "medium",
		task: "Change journal cache key behavior so different workspaces do not incorrectly reuse results, then add tests covering the new behavior and run focused validation.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
		projectStack: "node",
		projectProfile: KANADE_NODE_PROFILE,
		expectations: {
			requiresKinds: ["implement", "testChange"],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 4,
			minPrimarySteps: 2,
		},
	},
	{
		id: "M3",
		name: "generated-task prompt cleanup with built-in iteration policy",
		complexity: "medium",
		workflowSize: "medium",
		task: "Improve the generated workflow author prompt so routine tasks stay minimal, preserve the built-in iterate policy as a separate system path, and add focused tests for the prompt builder behavior.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
		projectStack: "node",
		projectProfile: KANADE_NODE_PROFILE,
		expectations: {
			requiresKinds: ["implement", "testChange"],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 4,
			minPrimarySteps: 2,
		},
	},
	{
		id: "J1",
		name: "java Maven module refactor",
		complexity: "medium",
		workflowSize: "medium",
		task: "Refactor error handling in the Java scheduler module and update focused tests. Keep changes confined to the affected area.",
		workspaceBrief: JAVA_MAVEN_WORKSPACE_BRIEF,
		projectStack: "java-maven",
		projectProfile: MAVEN_PROFILE,
		expectations: {
			requiresKinds: ["implement", "testChange"],
			forbidsKinds: ["analyze", "compareCandidates", "integrateChanges", "request_human"],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 4,
			minPrimarySteps: 2,
		},
	},
	{
		id: "P1",
		name: "python CLI bugfix with pytest",
		complexity: "medium",
		workflowSize: "medium",
		task: "Fix a Python CLI edge-case bug in argument parsing and add a regression test for it.",
		workspaceBrief: PYTHON_PYTEST_WORKSPACE_BRIEF,
		projectStack: "python",
		projectProfile: PYTHON_PROFILE,
		expectations: {
			requiresKinds: ["implement", "testChange"],
			forbidsKinds: ["analyze", "compareCandidates", "integrateChanges", "request_human"],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 4,
			minPrimarySteps: 2,
		},
	},
	{
		id: "G1",
		name: "java Gradle focused change",
		complexity: "medium",
		workflowSize: "medium",
		task: "Fix billing retry classification in the Gradle worker and update focused unit tests.",
		workspaceBrief: JAVA_GRADLE_WORKSPACE_BRIEF,
		projectStack: "java-gradle",
		projectProfile: GRADLE_PROFILE,
		expectations: {
			requiresKinds: ["implement", "testChange"],
			forbidsKinds: ["analyze", "compareCandidates", "integrateChanges", "request_human"],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 4,
			minPrimarySteps: 2,
		},
	},
	{
		id: "R1",
		name: "Rust CLI bugfix",
		complexity: "medium",
		workflowSize: "medium",
		task: "Fix a path normalization bug in the Rust file indexer CLI and add a regression test.",
		workspaceBrief: RUST_WORKSPACE_BRIEF,
		projectStack: "rust",
		projectProfile: RUST_PROFILE,
		expectations: {
			requiresKinds: ["implement", "testChange"],
			forbidsKinds: ["analyze", "compareCandidates", "integrateChanges", "request_human"],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 4,
			minPrimarySteps: 2,
		},
	},
	{
		id: "GO1",
		name: "Go handler bugfix",
		complexity: "medium",
		workflowSize: "medium",
		task: "Fix webhook signature handling in the Go relay service and add a focused regression test.",
		workspaceBrief: GO_WORKSPACE_BRIEF,
		projectStack: "go",
		projectProfile: GO_PROFILE,
		expectations: {
			requiresKinds: ["implement", "testChange"],
			forbidsKinds: ["analyze", "compareCandidates", "integrateChanges", "request_human"],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 4,
			minPrimarySteps: 2,
		},
	},
	{
		id: "D1",
		name: "docs-only handbook update",
		complexity: "simple",
		workflowSize: "small",
		task: "Clarify the on-call escalation documentation and verify links/formatting. This is a docs-only repository.",
		workspaceBrief: DOCS_ONLY_WORKSPACE_BRIEF,
		projectStack: "docs-only",
		projectProfile: DOCS_ONLY_PROFILE,
		expectations: {
			requiresKinds: ["implement"],
			forbidsKinds: [
				"analyze",
				"reviewChange",
				"continueImplementation",
				"compareCandidates",
				"integrateChanges",
				"request_human",
			],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 2,
			minPrimarySteps: 1,
			forbiddenGuidancePatterns: [
				/\bnpm\b/i,
				/\bnpx\b/i,
				/\b(?:\.\/)?mvnw?\b/i,
				/\bgradle(?:w)?\b/i,
				/\bpytest\b/i,
				/\bcargo\s+test\b/i,
				/\bgo\s+test\b/i,
			],
		},
	},
	{
		id: "X1",
		name: "explicit validation overrides profile",
		complexity: "simple",
		workflowSize: "small",
		task: "Update README wording only. Even though the profile suggests npm test, do not run npm; validate with `make docs-check` because this repository's docs checks are Make-based.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
		projectStack: "node",
		projectProfile: KANADE_NODE_PROFILE,
		expectations: {
			requiresKinds: ["implement"],
			forbidsKinds: [
				"analyze",
				"reviewChange",
				"continueImplementation",
				"compareCandidates",
				"integrateChanges",
				"request_human",
			],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 2,
			minPrimarySteps: 1,
			requiredGuidancePatterns: [/make\s+docs-check/i],
			forbiddenGuidancePatterns: [/\bnpx\b/i],
		},
	},
	{
		id: "S4",
		name: "docs typo and link cleanup",
		complexity: "simple",
		workflowSize: "small",
		task: "Fix a few typos in the README and verify the changed Markdown links/formatting only.",
		workspaceBrief: DOCS_ONLY_WORKSPACE_BRIEF,
		projectStack: "docs-only",
		projectProfile: DOCS_ONLY_PROFILE,
		expectations: {
			requiresKinds: ["implement"],
			forbidsKinds: [
				"analyze",
				"reviewChange",
				"continueImplementation",
				"compareCandidates",
				"integrateChanges",
				"request_human",
			],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 2,
			minPrimarySteps: 1,
			forbiddenGuidancePatterns: [/\bnpm\b/i, /\bpytest\b/i, /\bcargo\s+test\b/i, /\bgo\s+test\b/i],
		},
	},
	{
		id: "S5",
		name: "no-code recovery summary",
		complexity: "simple",
		workflowSize: "small",
		task: "Do not change code. Produce a concise summary of the current failed-task recovery behavior from the workspace brief and call out one risk to verify later.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
		projectStack: "node",
		projectProfile: KANADE_NODE_PROFILE,
		expectations: {
			requiresKinds: ["analyze"],
			forbidsKinds: [
				"implement",
				"reviewChange",
				"continueImplementation",
				"compareCandidates",
				"integrateChanges",
				"testChange",
				"request_human",
			],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 1,
			minPrimarySteps: 1,
		},
	},
	{
		id: "S6",
		name: "settings label polish",
		complexity: "simple",
		workflowSize: "small",
		task: "Rename one Cockpit Settings label for clarity and update the focused smoke test snapshot/assertion.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
		projectStack: "node",
		projectProfile: KANADE_NODE_PROFILE,
		expectations: {
			requiresKinds: ["implement", "testChange"],
			forbidsKinds: [
				"analyze",
				"reviewChange",
				"continueImplementation",
				"compareCandidates",
				"integrateChanges",
				"request_human",
			],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 2,
			minPrimarySteps: 2,
		},
	},
	{
		id: "S7",
		name: "CLI help text tweak",
		complexity: "simple",
		workflowSize: "small",
		task: "Clarify one kanade CLI help line for recovery cleanup and update only the matching CLI help test.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
		projectStack: "node",
		projectProfile: KANADE_NODE_PROFILE,
		expectations: {
			requiresKinds: ["implement", "testChange"],
			forbidsKinds: [
				"analyze",
				"reviewChange",
				"continueImplementation",
				"compareCandidates",
				"integrateChanges",
				"request_human",
			],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 2,
			minPrimarySteps: 2,
		},
	},
	{
		id: "S8",
		name: "config default docs sync",
		complexity: "simple",
		workflowSize: "small",
		task: "Sync a documented config default with the TypeScript config schema and add one focused config test if needed.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
		projectStack: "node",
		projectProfile: KANADE_NODE_PROFILE,
		expectations: {
			requiresKinds: ["implement"],
			forbidsKinds: [
				"analyze",
				"reviewChange",
				"continueImplementation",
				"compareCandidates",
				"integrateChanges",
				"request_human",
			],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 2,
			minPrimarySteps: 1,
		},
	},
	{
		id: "M4",
		name: "risky config auth gate",
		complexity: "medium",
		workflowSize: "medium",
		task: "Add support for optional auth headers in announcer config. Because this touches credential-like settings, ask for human confirmation before implementing the chosen config shape.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
		projectStack: "node",
		projectProfile: KANADE_NODE_PROFILE,
		expectations: {
			requiresKinds: ["analyze", "implement", "testChange"],
			preferNoLowLevelControls: true,
			requiresHumanGate: true,
			maxPrimarySteps: 5,
			minPrimarySteps: 3,
		},
	},
	{
		id: "M5",
		name: "model routing CLI option",
		complexity: "medium",
		workflowSize: "medium",
		task: "Add a CLI option for per-role model routing to generated task submission, update API parsing tests, and include a reviewer pass.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
		projectStack: "node",
		projectProfile: KANADE_NODE_PROFILE,
		expectations: {
			requiresKinds: ["implement", "reviewChange", "testChange"],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 4,
			minPrimarySteps: 3,
		},
	},
	{
		id: "M6",
		name: "recovery cleanup safety flow",
		complexity: "medium",
		workflowSize: "medium",
		task: "Improve recovery cleanup so dry-run output explains exactly what would be removed, add focused server and CLI tests, and run a reviewer pass for safety wording.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
		projectStack: "node",
		projectProfile: KANADE_NODE_PROFILE,
		expectations: {
			requiresKinds: ["implement", "reviewChange", "testChange"],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 4,
			minPrimarySteps: 3,
		},
	},
	{
		id: "M7",
		name: "Cockpit usage display refinement",
		complexity: "medium",
		workflowSize: "medium",
		task: "Refine the Cockpit Usage tab to group per-agent token usage by phase, keep the Pi extension lightweight, and update smoke coverage.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
		projectStack: "node",
		projectProfile: KANADE_NODE_PROFILE,
		expectations: {
			requiresKinds: ["implement", "testChange"],
			forbidsKinds: ["compareCandidates", "integrateChanges", "request_human"],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 4,
			minPrimarySteps: 2,
		},
	},
	{
		id: "M8",
		name: "unknown repo validation fallback",
		complexity: "medium",
		workflowSize: "medium",
		task: "Fix a focused bug in an unknown-stack repository. Do not assume npm; instruct the implementer/tester to inspect project files and run discovered relevant checks or explain the fallback.",
		workspaceBrief:
			"Repo: mystery-tool — repository stack is not known from the brief. Key instruction: inspect project markers before choosing validation commands. You do NOT have repository read/search tools in this mode.",
		projectStack: "unknown",
		expectations: {
			requiresKinds: ["implement", "testChange"],
			forbidsKinds: ["compareCandidates", "integrateChanges", "request_human"],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 4,
			minPrimarySteps: 2,
			requiredGuidancePatterns: [/inspect/i, /relevant project checks|discovered relevant checks|fallback/i],
			forbiddenGuidancePatterns: [/\bnpm\s+(?:test|run)\b/i],
		},
	},
	{
		id: "C1",
		name: "complex implementation with bounded analysis",
		complexity: "complex",
		workflowSize: "large",
		task: "Redesign the generated workflow author prompt so new tasks use a semantic V1 helper contract instead of raw agent orchestration, keep iterate on a separate built-in path, and update focused tests.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
		projectStack: "node",
		projectProfile: KANADE_NODE_PROFILE,
		expectations: {
			requiresKinds: ["analyze", "implement"],
			forbidsKinds: ["compareCandidates", "integrateChanges"],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 5,
			minPrimarySteps: 2,
		},
	},
	{
		id: "C2",
		name: "high-risk isolation redesign",
		complexity: "complex",
		workflowSize: "large",
		task: "Redesign isolation semantics for dynamic workflows. If the correct direction is unclear or the change could invalidate existing behavior, require explicit human confirmation before major implementation proceeds.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
		projectStack: "node",
		projectProfile: KANADE_NODE_PROFILE,
		expectations: {
			requiresKinds: ["implement"],
			preferNoLowLevelControls: true,
			requiresHumanGate: true,
			maxPrimarySteps: 6,
			minPrimarySteps: 3,
		},
	},
	{
		id: "C3",
		name: "startup recovery and human gate redesign",
		complexity: "complex",
		workflowSize: "large",
		task: "Redesign startup recovery for created, running, and needs_human tasks so assets are preserved, stale human requests are closed safely, and focused E2E coverage proves the behavior.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
		projectStack: "node",
		projectProfile: KANADE_NODE_PROFILE,
		expectations: {
			requiresKinds: ["analyze", "implement", "reviewChange", "testChange"],
			forbidsKinds: ["compareCandidates", "integrateChanges"],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 6,
			minPrimarySteps: 4,
		},
	},
	{
		id: "C4",
		name: "merge readiness review center",
		complexity: "complex",
		workflowSize: "large",
		task: "Build a merge-readiness Review Center that combines diff summary, test evidence, reviewer status, and safe action gating. Finished alone must not be treated as merge-ready.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
		projectStack: "node",
		projectProfile: KANADE_NODE_PROFILE,
		expectations: {
			requiresKinds: ["analyze", "implement", "reviewChange", "testChange"],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 6,
			minPrimarySteps: 4,
			requiredGuidancePatterns: [/finished alone|not.*merge-ready|merge-ready/i],
		},
	},
	{
		id: "C5",
		name: "project-agnostic author prompt expansion",
		complexity: "complex",
		workflowSize: "large",
		task: "Improve workflow generation so non-Node projects receive stack-appropriate validation guidance across Maven, Gradle, Python, Rust, Go, and docs-only repositories, with eval cases and scorer updates.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
		projectStack: "node",
		projectProfile: KANADE_NODE_PROFILE,
		expectations: {
			requiresKinds: ["analyze", "implement", "reviewChange", "testChange"],
			forbidsKinds: ["integrateChanges"],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 6,
			minPrimarySteps: 4,
			requiredGuidancePatterns: [/Maven|Gradle|Python|Rust|Go|docs-only/i],
		},
	},
	{
		id: "C6",
		name: "rerun cache evidence redesign",
		complexity: "complex",
		workflowSize: "large",
		task: "Redesign rerun cache evidence so cached agent calls are persisted, surfaced in task details and CLI output, and invalidated correctly for plain non-Git directories.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
		projectStack: "node",
		projectProfile: KANADE_NODE_PROFILE,
		expectations: {
			requiresKinds: ["analyze", "implement", "reviewChange", "testChange"],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 6,
			minPrimarySteps: 4,
			requiredGuidancePatterns: [/cache|from_cache|non-Git|plain/i],
		},
	},
	{
		id: "C7",
		name: "settings editor architecture",
		complexity: "complex",
		workflowSize: "large",
		task: "Design and implement a grouped, searchable Cockpit Settings editor with contextual raw preview, live/restart hints, validation, and focused smoke coverage while respecting the active Pi theme.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
		projectStack: "node",
		projectProfile: KANADE_NODE_PROFILE,
		expectations: {
			requiresKinds: ["analyze", "implement", "reviewChange", "testChange"],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 6,
			minPrimarySteps: 4,
			requiredGuidancePatterns: [/theme|restart|raw/i],
		},
	},
	{
		id: "C8",
		name: "complex Java Maven bugfix with review gate",
		complexity: "complex",
		workflowSize: "large",
		task: "Fix an intermittent scheduling bug across two Maven modules, add regression coverage, preserve public API compatibility, and require a reviewer pass plus a validation/fix loop before completion.",
		workspaceBrief: JAVA_MAVEN_WORKSPACE_BRIEF,
		projectStack: "java-maven",
		projectProfile: MAVEN_PROFILE,
		expectations: {
			requiresKinds: ["analyze", "implement", "reviewChange", "continueImplementation", "testChange"],
			forbidsKinds: ["compareCandidates", "integrateChanges", "request_human"],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 6,
			minPrimarySteps: 5,
			requiredGuidancePatterns: [/Maven|mvnw|mvn test/i, /public API|compat/i],
			forbiddenGuidancePatterns: [/\bnpm\b/i, /\bnpx\b/i, /\btypecheck\b/i],
		},
	},
];
