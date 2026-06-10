export type AuthorCaseComplexity = "simple" | "medium" | "complex";

export interface AuthorEvalCase {
	id: string;
	name: string;
	complexity: AuthorCaseComplexity;
	task: string;
	workspaceBrief: string;
	expectations: {
		requiresKinds?: string[];
		forbidsKinds?: string[];
		preferNoLowLevelControls?: boolean;
		maxPrimarySteps?: number;
		minPrimarySteps?: number;
		requiresHumanGate?: boolean;
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

export const AUTHOR_EVAL_CASES: AuthorEvalCase[] = [
	{
		id: "S1",
		name: "single-file bugfix",
		complexity: "simple",
		task: "Fix a retry bug in the login flow and add one targeted regression test.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
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
		task: "Add milliseconds to kanade tail event timestamps and update the relevant CLI tests.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
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
		task: "Add a small task-detail response field and run the focused app and CLI tests for that change only.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
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
		task: "Refactor workflow author prompt code into a cleaner module structure, keep current behavior, add or update focused tests, and include a reviewer pass after implementation.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
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
		task: "Change journal cache key behavior so different workspaces do not incorrectly reuse results, then add tests covering the new behavior and run focused validation.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
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
		task: "Improve the generated workflow author prompt so routine tasks stay minimal, preserve the built-in iterate policy as a separate system path, and add focused tests for the prompt builder behavior.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
		expectations: {
			requiresKinds: ["implement", "testChange"],
			preferNoLowLevelControls: true,
			maxPrimarySteps: 4,
			minPrimarySteps: 2,
		},
	},
	{
		id: "C1",
		name: "complex implementation with bounded analysis",
		complexity: "complex",
		task: "Redesign the generated workflow author prompt so new tasks use a semantic V1 helper contract instead of raw agent orchestration, keep iterate on a separate built-in path, and update focused tests.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
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
		task: "Redesign isolation semantics for dynamic workflows. If the correct direction is unclear or the change could invalidate existing behavior, require explicit human confirmation before major implementation proceeds.",
		workspaceBrief: KANADE_WORKSPACE_BRIEF,
		expectations: {
			requiresKinds: ["implement"],
			preferNoLowLevelControls: true,
			requiresHumanGate: true,
			maxPrimarySteps: 6,
			minPrimarySteps: 3,
		},
	},
];
