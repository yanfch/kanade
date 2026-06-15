/**
 * Smoke harness for the Kanade Pi extension.
 *
 * Exercises component-level behavior without a live Pi terminal.
 * Run via: npm run smoke:pi-kanade
 */

import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// 1. Fake fetch – canned Kanade server responses
// ---------------------------------------------------------------------------

const TASK: Record<string, unknown> = {
	id: "T-0001",
	status: "running",
	workflow_source: "generated",
	workflow_name: "test-workflow",
	created_at: Date.now() - 60_000,
	started_at: Date.now() - 30_000,
};

const TASK_FAILED: Record<string, unknown> = {
	id: "T-0002",
	status: "failed",
	workflow_source: "generated",
	workflow_name: "failed-workflow",
	error: "boom",
	created_at: Date.now() - 120_000,
	started_at: Date.now() - 90_000,
	finished_at: Date.now() - 30_000,
	worktree_summary: { status: "preserved", count: 1, branch: "kanade/T-0002", path: "/tmp/T-0002" },
};

const TASK_FAILED_MERGED: Record<string, unknown> = {
	id: "T-0006",
	status: "aborted",
	workflow_source: "saved",
	workflow_name: "failed-but-merged",
	error: "manual merge reconciled after abort",
	created_at: Date.now() - 180_000,
	started_at: Date.now() - 150_000,
	finished_at: Date.now() - 90_000,
	worktree_summary: {
		status: "merged",
		count: 1,
		branch: "kanade/T-0006",
		path: "/tmp/T-0006",
		merge_commit: "def456",
	},
};

const TASK_MERGED: Record<string, unknown> = {
	id: "T-0003",
	status: "finished",
	workflow_source: "generated",
	workflow_name: "merged-workflow",
	created_at: Date.now() - 240_000,
	started_at: Date.now() - 210_000,
	finished_at: Date.now() - 180_000,
	worktree_summary: {
		status: "merged",
		count: 1,
		branch: "kanade/T-0003",
		path: "/tmp/T-0003",
		merge_commit: "abc123",
	},
};

const TASK_BLOCKED: Record<string, unknown> = {
	id: "T-0004",
	status: "needs_human",
	workflow_source: "generated",
	workflow_name: "blocked-workflow",
	error: null,
	created_at: Date.now() - 120_000,
	started_at: Date.now() - 90_000,
	finished_at: null,
};

const TASK_CHECKS_MISSING: Record<string, unknown> = {
	id: "T-0005",
	status: "finished",
	workflow_source: "inline",
	workflow_name: "no-worktree-workflow",
	created_at: Date.now() - 60_000,
	started_at: Date.now() - 30_000,
	finished_at: Date.now() - 10_000,
	worktree_summary: { status: "none", count: 0 },
};

const SNAPSHOT: Record<string, unknown> = {
	name: "test-workflow",
	phases: ["implement"],
	currentPhase: "implement",
	logs: [],
	agents: [{ id: 1, label: "implement-agent", prompt: "do stuff", status: "running", phase: "implement" }],
	agentCount: 1,
	runningCount: 1,
	doneCount: 0,
	errorCount: 0,
	graph: {
		nodes: [
			{
				id: "p1",
				kind: "phase",
				label: "implement",
				status: "running",
				phase: "implement",
				createdAt: Date.now() - 25000,
				updatedAt: Date.now() - 5000,
			},
			{
				id: "a1",
				kind: "agent",
				label: "implement-agent",
				status: "running",
				phase: "implement",
				createdAt: Date.now() - 20000,
				updatedAt: Date.now() - 5000,
			},
		],
		edges: [],
		cursorNodeId: "a1",
	},
};

const SCRIPT = 'phase("implement")\nawait implement("fix the bug")\n';

const USAGE: Record<string, unknown> = {
	input: 1000,
	output: 500,
	totalTokens: 1500,
	cost: { total: 0.05 },
	agents: [
		{
			label: "implement-agent",
			phase: "Implement",
			status: "completed",
			model: "claude-sonnet-4",
			totalTokens: 900,
			cost: { total: 0.03 },
		},
		{
			label: "review-agent",
			phase: "Review",
			status: "completed",
			totalTokens: 600,
			cost: { total: 0.02 },
		},
	],
};

const REVIEW_READY: Record<string, unknown> = {
	task_id: "T-0001",
	status: "finished",
	state: "ready",
	mergeable: true,
	recommendation: "Task is ready for merge review",
	blockers: [],
	checks: {
		task_finished: true,
		worktree_exists: true,
		has_changes: true,
		no_agent_errors: true,
		all_phases_done: true,
		human_gates_resolved: true,
	},
	workflow: { source: "generated", name: "test-workflow" },
	worktree: { status: "active", has_changes: true },
	review: {
		agents: { total: 1, done: 1, failed: 0 },
		phases: { completed: 1, in_progress: 0 },
		human_gates: { pending: 0, resolved: 0 },
	},
	usage: USAGE,
	iteration_chain: ["T-0001"],
};

const REVIEW_MERGED: Record<string, unknown> = {
	task_id: "T-0003",
	status: "finished",
	state: "merged",
	mergeable: false,
	recommendation: "Already merged",
	blockers: [],
	checks: {},
	workflow: { source: "generated", name: "merged-workflow" },
	worktree: {
		status: "merged",
		has_changes: true,
		changed_files_count: 2,
		diff_stat: "2 files changed, 10 insertions(+), 5 deletions(-)",
	},
	review: {
		agents: { total: 0, done: 0, failed: 0 },
		phases: { completed: 0, in_progress: 0 },
		human_gates: { pending: 0, resolved: 0 },
	},
	usage: USAGE,
	iteration_chain: ["T-0003"],
};

const REVIEW_BLOCKED: Record<string, unknown> = {
	task_id: "T-0004",
	status: "needs_human",
	state: "blocked",
	mergeable: false,
	recommendation: "Not ready: blocked",
	blockers: ["Task is waiting for human input"],
	checks: { task_finished: false },
	workflow: { source: "generated", name: "blocked-workflow" },
	review: {
		agents: { total: 0, done: 0, failed: 0 },
		phases: { completed: 0, in_progress: 0 },
		human_gates: { pending: 1, resolved: 0 },
	},
	iteration_chain: ["T-0004"],
};

const REVIEW_FAILED_MERGED: Record<string, unknown> = {
	task_id: "T-0006",
	status: "aborted",
	state: "merged",
	mergeable: false,
	recommendation: "Already merged",
	blockers: [],
	checks: {},
	workflow: { source: "saved", name: "failed-but-merged" },
	worktree: {
		status: "merged",
		count: 1,
		branch: "kanade/T-0006",
		path: "/tmp/T-0006",
		merge_commit: "def456",
		has_changes: true,
		changed_files_count: 1,
		diff_stat: "1 file changed, 2 insertions(+)",
	},
	review: {
		agents: { total: 1, done: 1, failed: 0 },
		phases: { completed: 1, in_progress: 0 },
		human_gates: { pending: 0, resolved: 0 },
	},
	usage: USAGE,
	iteration_chain: ["T-0006"],
};

const REVIEW_NO_CHANGES: Record<string, unknown> = {
	task_id: "T-0005",
	status: "finished",
	state: "no_changes",
	mergeable: false,
	recommendation: "Not ready: no_changes",
	blockers: ["No worktree found"],
	checks: { task_finished: true, worktree_exists: false, has_changes: false },
	workflow: { source: "inline", name: "no-worktree-workflow" },
	worktree: { status: "none", count: 0 },
	review: {
		agents: { total: 0, done: 0, failed: 0 },
		phases: { completed: 0, in_progress: 0 },
		human_gates: { pending: 0, resolved: 0 },
	},
	iteration_chain: ["T-0005"],
};

const MOCK_CONFIG: Record<string, unknown> = {
	paths: {
		root: "/tmp/kanade",
		configFile: "/tmp/kanade/config.yml",
		dbDir: "/tmp/kanade/db",
		rolesDir: "/tmp/kanade/roles",
		workflowsDir: "/tmp/kanade/workflows",
		runsDir: "/tmp/kanade/runs",
		worktreesDir: "/tmp/kanade/worktrees",
		tracesDir: "/tmp/kanade/traces",
		stateDb: "/tmp/kanade/state.db",
		logsDir: "/tmp/kanade/logs",
		sharedExtensionsDir: "/tmp/kanade/extensions",
	},
	server: { port: 7777, bind: "127.0.0.1" },
	models: {
		mode: "inherit-pi",
		authPath: "/tmp/kanade/auth.json",
		agentDir: "/tmp/agents",
		piAgentDir: "/tmp/pi-agents",
		modelsPath: "/tmp/models",
		inheritPiSettings: true,
		disableSubagentCompaction: true,
	},
	defaults: {
		concurrency: 16,
		agentModel: "claude-sonnet-4",
		authorModel: "gpt-4o",
		roleModels: { implement: "claude-sonnet-4", review: "gpt-4o" },
		maxConcurrentTasks: 0,
		agentTimeoutMs: 1_800_000,
	},
	isolation: { defaultMode: "worktree", branchPrefix: "kanade" },
	merge: { targetBranch: "main", useNoFf: true, requireCleanLint: true, requireCleanTest: true },
	debug: { persistSubagents: false, dumpArtifacts: false },
	cleanup: { enabled: true, schedule: "0 * * * *" },
	network: { httpProxy: null, httpsProxy: null, allProxy: null, noProxy: null, httpIdleTimeoutMs: 300000 },
	liveAcceptance: { prepare: [], checks: [], timeoutMs: 1800000, pollMs: 10000 },
};

const WORKTREES: unknown[] = [];
const WORKTREES_MERGED: unknown[] = [
	{
		branch: "kanade/T-0003",
		worktree_path: "/tmp/T-0003",
		status: "merged",
		merge_commit: "abc123",
	},
];
const SESSIONS: unknown[] = [];

const fetchCalls: string[] = [];
const patchBodies: Record<string, unknown>[] = [];
const recoveryCleanupBodies: Record<string, unknown>[] = [];

function mockFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
	const raw = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
	const method = init?.method ?? "GET";
	fetchCalls.push(`${method} ${raw}`);
	const path = new URL(raw).pathname;

	const json = (data: unknown, status = 200) =>
		new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

	if (path === "/health") return json({ ok: true });
	if (path === "/tasks" && method === "GET")
		return json({ tasks: [TASK, TASK_FAILED, TASK_MERGED, TASK_BLOCKED, TASK_CHECKS_MISSING, TASK_FAILED_MERGED] });
	if (path === "/inbox") return json({ requests: [] });
	if (path === "/recovery/cleanup" && method === "POST") {
		let body: Record<string, unknown> = {};
		try {
			body = JSON.parse((init?.body as string) ?? "{}");
		} catch {}
		recoveryCleanupBodies.push(body);
		return json({
			dry_run: body.execute !== true,
			matched: 1,
			cleaned: body.execute === true ? 1 : 0,
			tasks: [TASK_FAILED],
		});
	}
	if (/^\/tasks\/T-0001\/snapshot$/.test(path)) return json({ snapshot: SNAPSHOT });
	if (/^\/tasks\/T-0001\/script$/.test(path)) return json({ script: SCRIPT });
	if (/^\/tasks\/T-0001\/worktrees$/.test(path)) return json({ worktrees: WORKTREES });
	if (/^\/tasks\/T-0001\/sessions$/.test(path)) return json({ sessions: SESSIONS });
	if (/^\/tasks\/T-0001\/review$/.test(path)) return json(REVIEW_READY);
	if (/^\/tasks\/T-0001$/.test(path) && method === "GET") return json({ task: TASK, usage: USAGE });
	if (/^\/tasks\/T-0003\/snapshot$/.test(path))
		return json({
			snapshot: {
				...SNAPSHOT,
				name: "merged-workflow",
				agents: [
					{ id: 1, label: "implement-agent", prompt: "do stuff", status: "done", phase: "implement" },
					{ id: 2, label: "review-agent", prompt: "review stuff", status: "done", phase: "review" },
				],
				graph: {
					nodes: [
						{
							id: "p1",
							kind: "phase",
							label: "implement",
							status: "done",
							phase: "implement",
							createdAt: Date.now() - 210000,
							updatedAt: Date.now() - 120000,
						},
						{
							id: "a1",
							kind: "agent",
							label: "implement-agent",
							status: "done",
							phase: "implement",
							createdAt: Date.now() - 210000,
							updatedAt: Date.now() - 120000,
						},
						{
							id: "p2",
							kind: "phase",
							label: "review",
							status: "done",
							phase: "review",
							createdAt: Date.now() - 120000,
							updatedAt: Date.now() - 180000,
						},
						{
							id: "a2",
							kind: "agent",
							label: "review-agent",
							status: "done",
							phase: "review",
							createdAt: Date.now() - 120000,
							updatedAt: Date.now() - 180000,
						},
					],
					edges: [],
				},
			},
		});
	if (/^\/tasks\/T-0003\/script$/.test(path)) return json({ script: SCRIPT });
	if (/^\/tasks\/T-0003\/worktrees$/.test(path)) return json({ worktrees: WORKTREES_MERGED });
	if (/^\/tasks\/T-0003\/sessions$/.test(path)) return json({ sessions: [] });
	if (/^\/tasks\/T-0003\/review$/.test(path)) return json(REVIEW_MERGED);
	if (/^\/tasks\/T-0003$/.test(path) && method === "GET") return json({ task: TASK_MERGED, usage: USAGE });
	if (/^\/tasks\/T-0004\/review$/.test(path)) return json(REVIEW_BLOCKED);
	if (/^\/tasks\/T-0004$/.test(path) && method === "GET") return json({ task: TASK_BLOCKED, usage: null });
	if (/^\/tasks\/T-0004\/snapshot$/.test(path))
		return json({ snapshot: { ...SNAPSHOT, name: "blocked-workflow", agents: [] } });
	if (/^\/tasks\/T-0004\/script$/.test(path)) return json({ script: SCRIPT });
	if (/^\/tasks\/T-0004\/worktrees$/.test(path)) return json({ worktrees: [] });
	if (/^\/tasks\/T-0004\/sessions$/.test(path)) return json({ sessions: [] });
	if (/^\/tasks\/T-0005\/review$/.test(path)) return json(REVIEW_NO_CHANGES);
	if (/^\/tasks\/T-0005$/.test(path) && method === "GET") return json({ task: TASK_CHECKS_MISSING, usage: null });
	if (/^\/tasks\/T-0005\/snapshot$/.test(path))
		return json({ snapshot: { ...SNAPSHOT, name: "no-worktree-workflow", agents: [] } });
	if (/^\/tasks\/T-0005\/script$/.test(path)) return json({ script: SCRIPT });
	if (/^\/tasks\/T-0005\/worktrees$/.test(path)) return json({ worktrees: [] });
	if (/^\/tasks\/T-0005\/sessions$/.test(path)) return json({ sessions: [] });
	if (/^\/tasks\/T-0006\/review$/.test(path)) return json(REVIEW_FAILED_MERGED);
	if (/^\/tasks\/T-0006$/.test(path) && method === "GET") return json({ task: TASK_FAILED_MERGED, usage: USAGE });
	if (/^\/tasks\/T-0006\/snapshot$/.test(path)) return json({ snapshot: { ...SNAPSHOT, name: "failed-but-merged" } });
	if (/^\/tasks\/T-0006\/script$/.test(path)) return json({ script: SCRIPT });
	if (/^\/tasks\/T-0006\/worktrees$/.test(path))
		return json({
			worktrees: [{ branch: "kanade/T-0006", worktree_path: "/tmp/T-0006", status: "merged", merge_commit: "def456" }],
		});
	if (/^\/tasks\/T-0006\/sessions$/.test(path)) return json({ sessions: [] });
	if (path === "/config" && method === "GET") return json(MOCK_CONFIG);
	if (path === "/config" && method === "PATCH") {
		let body: Record<string, unknown> = {};
		try {
			body = JSON.parse((init?.body as string) ?? "{}");
		} catch {}
		patchBodies.push(body);
		if (Object.keys(body).some((key) => key.includes("."))) {
			return json({ error: "dotted top-level keys are not accepted" }, 400);
		}
		// Apply nested patch to mock config, matching the real PATCH /config API shape.
		for (const [section, sectionPatch] of Object.entries(body)) {
			if (typeof sectionPatch !== "object" || sectionPatch === null) continue;
			const target = (MOCK_CONFIG[section] ?? {}) as Record<string, unknown>;
			MOCK_CONFIG[section] = { ...target, ...(sectionPatch as Record<string, unknown>) };
		}
		return json({ ok: true, config: MOCK_CONFIG });
	}

	// SSE event replay for tasks
	if (/^\/tasks\/T-0001\/events$/.test(path)) {
		const now = Date.now();
		const sse = [
			`event: task.created\nid: 1\ndata: ${JSON.stringify({ id: 1, type: "task.created", taskId: "T-0001", data: { workflowPath: "/tmp/workflow.js" }, ts: now - 60000 })}\n\n`,
			`event: task.running\nid: 2\ndata: ${JSON.stringify({ id: 2, type: "task.running", taskId: "T-0001", data: {}, ts: now - 30000 })}\n\n`,
			`event: workflow.phase\nid: 3\ndata: ${JSON.stringify({ id: 3, type: "workflow.phase", taskId: "T-0001", data: { phase: "implement" }, ts: now - 25000 })}\n\n`,
			`event: workflow.agent_started\nid: 4\ndata: ${JSON.stringify({ id: 4, type: "workflow.agent_started", taskId: "T-0001", data: { label: "implement-agent" }, ts: now - 20000 })}\n\n`,
		].join("");
		return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
	}
	if (/^\/tasks\/T-0002\/events$/.test(path)) {
		const now = Date.now();
		const sse = [
			`event: task.created\nid: 1\ndata: ${JSON.stringify({ id: 1, type: "task.created", taskId: "T-0002", data: {}, ts: now - 120000 })}\n\n`,
			`event: task.failed\nid: 2\ndata: ${JSON.stringify({ id: 2, type: "task.failed", taskId: "T-0002", data: { error: "boom" }, ts: now - 30000 })}\n\n`,
		].join("");
		return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
	}
	if (/^\/tasks\/T-0003\/events$/.test(path)) {
		const now = Date.now();
		const sse = [
			`event: task.created\nid: 1\ndata: ${JSON.stringify({ id: 1, type: "task.created", taskId: "T-0003", data: {}, ts: now - 240000 })}\n\n`,
			`event: task.merged\nid: 2\ndata: ${JSON.stringify({ id: 2, type: "task.merged", taskId: "T-0003", data: { mergeCommit: "abc123" }, ts: now - 180000 })}\n\n`,
		].join("");
		return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
	}
	if (/^\/tasks\/T-0004\/events$/.test(path)) {
		const now = Date.now();
		const sse = [
			`event: task.needs_human\nid: 1\ndata: ${JSON.stringify({ id: 1, type: "task.needs_human", taskId: "T-0004", data: { request: { title: "Approve deployment?" } }, ts: now - 50000 })}\n\n`,
		].join("");
		return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
	}
	if (/^\/tasks\/T-0005\/events$/.test(path)) {
		return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
	}
	if (/^\/tasks\/T-0006\/events$/.test(path)) {
		const now = Date.now();
		const sse = [
			`event: task.aborted\nid: 1\ndata: ${JSON.stringify({ id: 1, type: "task.aborted", taskId: "T-0006", data: {}, ts: now - 100000 })}\n\n`,
			`event: task.merged\nid: 2\ndata: ${JSON.stringify({ id: 2, type: "task.merged", taskId: "T-0006", data: { mergeCommit: "def456" }, ts: now - 90000 })}\n\n`,
		].join("");
		return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
	}

	// Task-detail sub-requests that return errors (for test 5)
	if (/^\/tasks\/T-0002/.test(path)) {
		if (/\/(task|script|worktrees|sessions)$/.test(path)) return json({ error: "not found" }, 500);
		if (/\/snapshot$/.test(path))
			return json({
				snapshot: {
					name: "failed-workflow",
					phases: [],
					agents: [],
					logs: [],
					agentCount: 0,
					runningCount: 0,
					doneCount: 0,
					errorCount: 0,
				},
			});
		if (method === "GET") return json({ task: TASK_FAILED, usage: null }, 500);
	}

	return json({});
}

(globalThis as Record<string, unknown>).fetch = mockFetch;

// ---------------------------------------------------------------------------
// 2. Fake ExtensionAPI / context / theme
// ---------------------------------------------------------------------------

type EventHandler = (event: unknown, ctx: unknown) => unknown;
type ToolDef = { name: string; execute: Function };
type CommandDef = { name: string; handler: Function };

const handlers = new Map<string, EventHandler>();
const tools: ToolDef[] = [];
const commands: CommandDef[] = [];

// Tracks ui.custom calls and allows resolving them externally
const customCalls: Array<{
	component: unknown;
	resolve: (v: unknown) => void;
	promise: Promise<unknown>;
}> = [];

function createFakeApi() {
	return {
		on: (event: string, handler: EventHandler) => handlers.set(event, handler),
		registerTool: (tool: ToolDef) => tools.push(tool),
		registerCommand: (name: string, cmd: CommandDef) => commands.push({ name, ...cmd }),
		registerShortcut: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "none",
		setThinkingLevel: () => {},
		registerProvider: () => {},
		unregisterProvider: () => {},
		events: { on: () => () => {}, emit: () => {} },
	};
}

function createFakeContext(overrides?: { mode?: string; confirmResult?: boolean }) {
	const theme = {
		fg: (_kind: string, text: string) => text,
	};
	return {
		hasUI: true,
		mode: overrides?.mode ?? "tui",
		ui: {
			theme,
			custom: <T>(
				factory: (tui: { requestRender: () => void }, thm: typeof theme, kb: unknown, done: (v: T) => void) => unknown,
				_opts?: unknown,
			): Promise<T> => {
				let resolve!: (v: T) => void;
				const promise = new Promise<T>((r) => {
					resolve = r;
				});
				const tui = { requestRender: () => {} };
				const component = factory(tui, theme, {}, resolve as (v: unknown) => void);
				customCalls.push({ component, resolve: resolve as (v: unknown) => void, promise });
				return promise;
			},
			notify: () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			editor: async () => undefined,
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
			select: async () => undefined,
			confirm: async () => overrides?.confirmResult ?? false,
			input: async () => undefined,
			onTerminalInput: () => () => {},
		},
		cwd: "/tmp",
		sessionManager: {},
		modelRegistry: {},
		model: undefined,
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	};
}

// ---------------------------------------------------------------------------
// 3. Load & register the extension
// ---------------------------------------------------------------------------

const extPath = resolve(import.meta.dirname ?? process.cwd(), "../.pi/extensions/kanade/index.ts");
// tsx handles the .ts import; the extension uses only node + pi packages already installed
const extMod = await import(extPath);
const kanadeExtension = extMod.default as (api: ReturnType<typeof createFakeApi>) => void;

const fakeApi = createFakeApi();
kanadeExtension(fakeApi);

// Fire session_start so the status timer is set up (harmless)
const sessionStartHandler = handlers.get("session_start");
const ctxForEvents = createFakeContext();
if (sessionStartHandler) await sessionStartHandler({ type: "session_start" }, ctxForEvents);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

async function delay(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

/** Create a KanadePanel via the registered /kanade command and return it. */
async function createPanel(confirmResult?: boolean) {
	const cmd = commands.find((c) => c.name === "kanade");
	if (!cmd) throw new Error("kanade command not registered");
	// Fire the handler; it will call ui.custom internally
	const cmdCtx = createFakeContext(confirmResult !== undefined ? { confirmResult } : undefined);
	void cmd.handler("", cmdCtx);
	// Let the async handler reach ui.custom and the panel constructor + refresh settle
	await delay(250);
	const entry = customCalls.at(-1);
	if (!entry) throw new Error("ui.custom was not called – KanadePanel was not created");
	return entry.component as { render(w: number): string[]; handleInput(d: string): void };
}

type TestComponent = { render(w: number): string[]; handleInput?: (d: string) => void };

function selectedSettingsLine(comp: TestComponent): string {
	return (
		strip(comp.render(90).join("\n"))
			.split("\n")
			.find((line) => line.includes("▸")) ?? ""
	);
}

async function selectSettingsLine(comp: TestComponent, label: string): Promise<boolean> {
	for (let i = 0; i < 80; i++) comp.handleInput?.("\x1b[A");
	for (let i = 0; i < 80; i++) {
		if (selectedSettingsLine(comp).includes(label)) return true;
		comp.handleInput?.("\x1b[B");
		await delay(5);
	}
	return false;
}

async function expandSettingsGroup(comp: TestComponent, label: string): Promise<boolean> {
	if (!(await selectSettingsLine(comp, label))) return false;
	const line = selectedSettingsLine(comp);
	if (line.includes("[+]")) {
		comp.handleInput?.("\r");
		await delay(20);
	}
	return true;
}

async function selectSettingsField(comp: TestComponent, group: string, label: string): Promise<boolean> {
	if (!(await expandSettingsGroup(comp, group))) return false;
	for (let i = 0; i < 30; i++) {
		if (selectedSettingsLine(comp).includes(label)) return true;
		comp.handleInput?.("\x1b[B");
		await delay(5);
	}
	return false;
}

// ---------------------------------------------------------------------------
// 4. Tests
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean, detail?: string) {
	if (condition) {
		console.log(`  ✓ ${label}`);
		passed++;
	} else {
		console.error(`  ✖ ${label}${detail ? ` – ${detail}` : ""}`);
		failed++;
	}
}

// ---------- Test 1: wide render ----------
{
	console.log("Test 1: wide render produces task list + detail + full-height divider");
	const panel = await createPanel();
	let threw = false;
	let output: string[] = [];
	try {
		output = panel.render(120);
	} catch {
		threw = true;
	}
	const text = strip(output.join("\n"));
	assert("render does not throw", !threw);
	assert("contains panel title", text.includes("Kanade Cockpit"), `missing title in ${text.slice(0, 200)}`);
	assert("shows task count", text.includes("Tasks"));
	assert("shows task id", text.includes("T-0001"), `missing T-0001 in ${text.slice(0, 300)}`);
	assert("contains vertical divider (│)", text.includes("│"), "missing divider");
	assert("output has substantial rows (>15)", output.length > 15, `only ${output.length} rows`);
}

// ---------- Test 2: narrow render still shows detail ----------
{
	console.log("\nTest 2: narrow render still shows task detail");
	const panel = await createPanel();
	const output = panel.render(80);
	const text = strip(output.join("\n"));
	assert("render succeeds at width 80", output.length > 0);
	assert("shows task id in narrow mode", text.includes("T-0001"), "missing T-0001");
	// In narrow mode the detail section appears after a rule separator
	assert(
		"shows detail area (tabs or status)",
		text.includes("Map") || text.includes("running"),
		"missing detail content",
	);
}

// ---------- Test 3: search + Enter opens actions modal ----------
{
	console.log("\nTest 3: search input + Enter opens the actions modal");
	const panel = await createPanel();
	customCalls.length = 0; // reset

	panel.handleInput("/");
	panel.handleInput("T");
	panel.handleInput("-");
	panel.handleInput("0");
	panel.handleInput("0");
	panel.handleInput("0");
	panel.handleInput("1");

	panel.handleInput("\r"); // Enter

	await delay(100);

	const lastCall = customCalls.at(-1);
	assert("ui.custom was called after Enter", lastCall !== undefined, `calls: ${customCalls.length}`);
	// The overlay is an ActionMenuOverlay if its render output contains "Actions"
	if (lastCall) {
		const comp = lastCall.component as { render(w: number): string[] } | undefined;
		const overlayText = comp ? strip(comp.render(60).join("\n")) : "";
		assert("overlay renders Actions menu", overlayText.includes("Actions"), `overlay: ${overlayText.slice(0, 200)}`);
		// Clean up: dismiss the overlay so the panel's actionInProgress resets
		const handler = (comp as { handleInput?: (d: string) => void })?.handleInput;
		if (handler) handler.call(comp, "\x1b"); // Escape
		await delay(50);
	}
}

// ---------- Test 4: Backspace edits search after modal ----------
{
	console.log("\nTest 4: Backspace edits search query after returning from modal");
	const panel = await createPanel();

	// Build up a search query
	panel.handleInput("/");
	for (const ch of "T-0001") panel.handleInput(ch);

	// Press Enter to open actions modal
	panel.handleInput("\r");
	await delay(100);

	// Dismiss modal with Escape
	const call = customCalls.at(-1);
	if (call) {
		const comp = call.component as { handleInput?: (d: string) => void };
		comp?.handleInput?.("\x1b");
		call.resolve(null);
	}
	await delay(100);

	// Now press Backspace
	panel.handleInput("backspace");
	const output = panel.render(100);
	const text = strip(output.join("\n"));
	// "T-000" (one char removed) should appear in the search line
	assert("search shows edited query after Backspace", text.includes("T-000"), `output: ${text.slice(0, 400)}`);
	assert("original full query is gone", !text.includes("search: T-0001▏"), "full query still present with cursor");
}

// ---------- Test 5: non-live Agent Detail has no auto-refresh text ----------
{
	console.log("\nTest 5: Agent Detail for failed task does not show auto-refresh");

	// Use a separate context with a fresh customCalls to capture the AgentDetailOverlay
	customCalls.length = 0;
	const cmd = commands.find((c) => c.name === "kanade");
	const cmdCtx = createFakeContext();
	void cmd.handler("", cmdCtx);
	await delay(250);

	const panel = customCalls.at(-1)?.component as {
		render(w: number): string[];
		handleInput(d: string): void;
	};
	if (!panel) {
		assert("panel created for test 5", false);
	} else {
		// Point the panel at the failed task T-0002 via search
		panel.handleInput("/");
		for (const ch of "T-0002") panel.handleInput(ch);
		panel.handleInput("\r"); // Enter to exit search mode + auto-open actions
		await delay(150);

		// Dismiss the auto-opened action menu so actionInProgress resets
		const autoActionCall = customCalls.at(-1);
		if (autoActionCall) {
			const overlayComp = autoActionCall.component as { handleInput?: (d: string) => void };
			overlayComp?.handleInput?.("\x1b"); // Escape
			autoActionCall.resolve(null);
		}
		await delay(150);

		// Now press 'f' to open Agent Detail overlay
		customCalls.length = 0;
		panel.handleInput("f");
		await delay(400);

		const detailEntry = customCalls.at(-1);
		if (!detailEntry) {
			assert("Agent Detail overlay opened", false, "ui.custom not called for 'f'");
		} else {
			const detailComp = detailEntry.component as { render(w: number): string[] };
			// Wait a bit more for the async fetchTaskDetail to settle
			await delay(400);
			const detailText = strip(detailComp.render(100).join("\n"));
			assert(
				"no auto-refresh text for failed task",
				!detailText.includes("auto-refresh"),
				`found auto-refresh in: ${detailText.slice(0, 500)}`,
			);
			assert(
				"shows close hint",
				detailText.includes("Esc close") || detailText.includes("r refresh"),
				`missing hints in: ${detailText.slice(0, 300)}`,
			);
			// Clean up: dismiss the overlay
			(detailComp as { handleInput?: (d: string) => void }).handleInput?.("\x1b");
			detailEntry.resolve(undefined);
			await delay(50);
		}
	}
}

// ---------- Test 5b: failed task action menu includes recovery actions ----------
{
	console.log("\nTest 5b: failed task action menu includes recovery actions");
	customCalls.length = 0;
	const panel = await createPanel();
	panel.handleInput("/");
	for (const ch of "T-0002") panel.handleInput(ch);
	panel.handleInput("\r");
	await delay(150);
	const actionCall = customCalls.at(-1);
	if (!actionCall) {
		assert("action menu opened", false);
	} else {
		const overlayComp = actionCall.component as { render(w: number): string[]; handleInput?: (d: string) => void };
		const text = strip(overlayComp.render(80).join("\n"));
		assert("action menu opened", text.includes("Actions"), `overlay: ${text.slice(0, 300)}`);
		assert("shows reconcile action", text.includes("Reconcile manual merge"), `overlay: ${text.slice(0, 300)}`);
		assert("shows cleanup action", text.includes("Cleanup preserved worktree"), `overlay: ${text.slice(0, 300)}`);
		overlayComp.handleInput?.("\x1b");
		actionCall.resolve(null);
	}
}

// ---------- Test 5c: failed-but-merged task actions are read-only ----------
{
	console.log("\nTest 5c: failed-but-merged task actions are read-only");
	customCalls.length = 0;
	const panel = await createPanel();
	panel.handleInput("/");
	for (const ch of "T-0006") panel.handleInput(ch);
	panel.handleInput("\r");
	await delay(150);
	const actionCall = customCalls.at(-1);
	if (!actionCall) {
		assert("action menu opened", false);
	} else {
		const overlayComp = actionCall.component as { render(w: number): string[]; handleInput?: (d: string) => void };
		const text = strip(overlayComp.render(90).join("\n"));
		assert("action menu opened", text.includes("Actions"), `overlay: ${text.slice(0, 400)}`);
		assert("shows merge summary action", text.includes("Open merge summary"), `overlay: ${text.slice(0, 400)}`);
		assert(
			"hides reconcile for merged task",
			!text.includes("Reconcile manual merge"),
			`overlay: ${text.slice(0, 400)}`,
		);
		assert(
			"hides cleanup for merged task",
			!text.includes("Cleanup preserved worktree"),
			`overlay: ${text.slice(0, 400)}`,
		);
		assert(
			"hides iterate for merged failed task",
			!text.includes("Iterate with instructions"),
			`overlay: ${text.slice(0, 400)}`,
		);
		overlayComp.handleInput?.("\x1b");
		actionCall.resolve(null);
	}
}

// ---------- Test 5d: cleanup action dry-runs before confirmation ----------
{
	console.log("\nTest 5d: cleanup action dry-runs before confirmation");
	customCalls.length = 0;
	recoveryCleanupBodies.length = 0;
	const panel = await createPanel();
	panel.handleInput("/");
	for (const ch of "T-0002") panel.handleInput(ch);
	panel.handleInput("\r");
	await delay(150);
	const actionCall = customCalls.at(-1);
	if (!actionCall) {
		assert("action menu opened", false);
	} else {
		const overlayComp = actionCall.component as { render(w: number): string[]; handleInput?: (d: string) => void };
		for (let i = 0; i < 3; i++) overlayComp.handleInput?.("\x1b[B");
		overlayComp.handleInput?.("\r");
		await delay(250);
		assert("dry-run POST sent", recoveryCleanupBodies.length === 1, JSON.stringify(recoveryCleanupBodies));
		assert(
			"dry-run targets task",
			recoveryCleanupBodies[0]?.task_id === "T-0002",
			JSON.stringify(recoveryCleanupBodies[0]),
		);
		assert(
			"dry-run does not execute",
			recoveryCleanupBodies[0]?.execute !== true,
			JSON.stringify(recoveryCleanupBodies[0]),
		);
		const confirmCall = customCalls.at(-1);
		const confirmComp = confirmCall?.component as
			| { render(w: number): string[]; handleInput?: (d: string) => void }
			| undefined;
		const text = strip(confirmComp?.render(90).join("\n") ?? "");
		assert("confirm overlay shows dry-run summary", text.includes("Dry-run matched"), `overlay: ${text.slice(0, 400)}`);
		confirmCall?.resolve(false);
		await delay(150);
		assert(
			"cancel does not execute cleanup",
			recoveryCleanupBodies.length === 1,
			JSON.stringify(recoveryCleanupBodies),
		);
	}
}

// ---------- Test 5e: cleanup action executes only after confirmation ----------
{
	console.log("\nTest 5e: cleanup action executes only after confirmation");
	customCalls.length = 0;
	recoveryCleanupBodies.length = 0;
	const panel = await createPanel();
	panel.handleInput("/");
	for (const ch of "T-0002") panel.handleInput(ch);
	panel.handleInput("\r");
	await delay(150);
	const actionCall = customCalls.at(-1);
	if (!actionCall) {
		assert("action menu opened", false);
	} else {
		const overlayComp = actionCall.component as { handleInput?: (d: string) => void };
		for (let i = 0; i < 3; i++) overlayComp.handleInput?.("\x1b[B");
		overlayComp.handleInput?.("\r");
		await delay(250);
		const confirmCall = customCalls.at(-1);
		confirmCall?.resolve(true);
		await delay(300);
		assert("dry-run and execute POST sent", recoveryCleanupBodies.length === 2, JSON.stringify(recoveryCleanupBodies));
		assert(
			"execute cleanup confirmed",
			recoveryCleanupBodies[1]?.execute === true,
			JSON.stringify(recoveryCleanupBodies[1]),
		);
		assert(
			"execute cleanup has confirmed flag",
			recoveryCleanupBodies[1]?.confirmed === true,
			JSON.stringify(recoveryCleanupBodies[1]),
		);
	}
}

// ---------- Test 6: merged task list badge stays concise ----------
{
	console.log("\nTest 6: merged task list badge stays concise");
	const panel = await createPanel();
	panel.handleInput("/");
	for (const ch of "T-0003") panel.handleInput(ch);
	await delay(150);
	const output = panel.render(120);
	const text = strip(output.join("\n"));
	const taskLine = text
		.split("\n")
		.find((line) => line.includes("T-0003"))
		?.trim();
	assert("merged task appears", Boolean(taskLine), `output: ${text.slice(0, 500)}`);
	assert("list shows merged state", Boolean(taskLine?.includes("merged")), `line: ${taskLine}`);
	assert("list omits commit/file counts", !/commits?|files?/.test(taskLine ?? ""), `line too noisy: ${taskLine}`);
}

// ---------- Test 7: Worktree tab keeps detailed diff summary ----------
{
	console.log("\nTest 7: Worktree tab shows detailed diff summary");
	customCalls.length = 0;
	const panel = await createPanel();
	panel.handleInput("/");
	for (const ch of "T-0003") panel.handleInput(ch);
	panel.handleInput("\r"); // opens actions for the selected task
	await delay(150);
	const actionCall = customCalls.at(-1);
	if (actionCall) {
		const overlayComp = actionCall.component as { handleInput?: (d: string) => void };
		overlayComp?.handleInput?.("\x1b");
		actionCall.resolve(null);
	}
	await delay(150);
	panel.handleInput("\t");
	panel.handleInput("\t");
	panel.handleInput("\t");
	await delay(300);
	const text = strip(panel.render(120).join("\n"));
	assert("Worktree tab selected", text.includes("[Worktree]"), `output: ${text.slice(0, 500)}`);
	assert("shows diff stat in detail", text.includes("2 files changed"), `output: ${text.slice(0, 800)}`);
	assert("shows merge commit in detail", text.includes("abc123"), `output: ${text.slice(0, 800)}`);
}

// ---------- Test 8: already-merged task cannot be merged again ----------
{
	console.log("\nTest 8: already-merged task action menu hides Merge task");
	customCalls.length = 0;
	const panel = await createPanel();
	panel.handleInput("/");
	for (const ch of "T-0003") panel.handleInput(ch);
	panel.handleInput("\r");
	await delay(150);
	const actionCall = customCalls.at(-1);
	if (!actionCall) {
		assert("action menu opened", false);
	} else {
		const overlayComp = actionCall.component as { render(w: number): string[]; handleInput?: (d: string) => void };
		const text = strip(overlayComp.render(80).join("\n"));
		assert("action menu opened", text.includes("Actions"), `overlay: ${text.slice(0, 300)}`);
		assert("Merge task hidden for merged task", !text.includes("Merge task"), `overlay: ${text.slice(0, 300)}`);
		overlayComp.handleInput?.("\x1b");
		actionCall.resolve(null);
	}
}

// ---------- Test 9: readiness summary renders Review tab ----------
{
	console.log("\nTest 9: readiness summary renders Review tab");
	customCalls.length = 0;
	const panel = await createPanel();
	panel.handleInput("/");
	for (const ch of "T-0001") panel.handleInput(ch);
	await delay(200);
	// Navigate to Review tab (Tab 6 times to cycle past Map,Agent,Events,Worktree,Usage,Result)
	for (let i = 0; i < 6; i++) panel.handleInput("\t");
	await delay(200);
	const text = strip(panel.render(120).join("\n"));
	assert("Review tab selected", text.includes("[Review]"), `output: ${text.slice(0, 500)}`);
	assert("shows merge readiness label", text.includes("Merge Readiness"), `output: ${text.slice(0, 800)}`);
	assert("shows ready state", text.includes("Ready") || text.includes("ready"), `output: ${text.slice(0, 800)}`);
}

// ---------- Test 9b: Usage tab renders per-agent usage ----------
{
	console.log("\nTest 9b: Usage tab shows per-agent usage");
	customCalls.length = 0;
	const panel = await createPanel();
	panel.handleInput("/");
	for (const ch of "T-0001") panel.handleInput(ch);
	await delay(200);
	for (let i = 0; i < 4; i++) panel.handleInput("\t");
	await delay(200);
	const text = strip(panel.render(120).join("\n"));
	assert("Usage tab selected", text.includes("[Usage]"), `output: ${text.slice(0, 500)}`);
	assert("shows per-agent usage section", text.includes("Per-Agent Usage"), `output: ${text.slice(0, 800)}`);
	assert("shows implement agent usage", text.includes("implement-agent"), `output: ${text.slice(0, 800)}`);
	assert("shows review agent usage", text.includes("review-agent"), `output: ${text.slice(0, 800)}`);
}

// ---------- Test 10: blocked task shows blockers in Review tab ----------
{
	console.log("\nTest 10: blocked task shows blockers in Review tab");
	customCalls.length = 0;
	const panel = await createPanel();
	panel.handleInput("/");
	for (const ch of "T-0004") panel.handleInput(ch);
	await delay(200);
	for (let i = 0; i < 6; i++) panel.handleInput("\t");
	await delay(200);
	const text = strip(panel.render(120).join("\n"));
	assert("shows blocked state", text.includes("Blocked"), `output: ${text.slice(0, 800)}`);
	assert(
		"shows blocker message",
		text.includes("human input") || text.includes("Blockers"),
		`output: ${text.slice(0, 800)}`,
	);
}

// ---------- Test 11: merged task list row stays concise ----------
{
	console.log("\nTest 11: merged task list row stays concise with readiness badge");
	const panel = await createPanel();
	const output = panel.render(120);
	const text = strip(output.join("\n"));
	// Find the T-0003 line in the task list
	const taskLine = text
		.split("\n")
		.find((line) => line.includes("T-0003"))
		?.trim();
	assert("merged task appears in list", Boolean(taskLine), `output: ${text.slice(0, 500)}`);
	assert("list shows merged badge", Boolean(taskLine?.includes("merged")), `line: ${taskLine}`);
	assert("list omits commit/file noise", !/commits?|files?/.test(taskLine ?? ""), `line too noisy: ${taskLine}`);
}

// ---------- Test 12: blocked task shows in list ----------
{
	console.log("\nTest 12: blocked task (T-0004) shows in task list");
	const panel = await createPanel();
	const output = panel.render(120);
	const text = strip(output.join("\n"));
	const taskLine = text
		.split("\n")
		.find((line) => line.includes("T-0004"))
		?.trim();
	assert("blocked task appears in list", Boolean(taskLine), `output: ${text.slice(0, 600)}`);
	// The list may show status differently; just verify the task appears
	assert(
		"shows blocked or needs_human",
		Boolean(taskLine?.includes("blocked") || taskLine?.includes("needs_human")),
		`line: ${taskLine}`,
	);
}

// ---------- Test 13: Settings is global, not task action ----------
{
	console.log("\nTest 13: Settings opens globally and is not in task actions");
	customCalls.length = 0;
	const panel = await createPanel();
	panel.handleInput("/");
	for (const ch of "T-0001") panel.handleInput(ch);
	panel.handleInput("\r");
	await delay(150);
	const actionCall = customCalls.at(-1);
	if (!actionCall) {
		assert("action menu opened for settings test", false);
	} else {
		const overlayComp = actionCall.component as { render(w: number): string[]; handleInput?: (d: string) => void };
		const menuText = strip(overlayComp.render(80).join("\n"));
		assert("Settings not in task action menu", !menuText.includes("Settings"), `menu: ${menuText.slice(0, 300)}`);
		overlayComp.handleInput?.("\x1b");
		actionCall.resolve(null);
		await delay(100);
	}

	customCalls.length = 0;
	panel.handleInput("s");
	await delay(150);
	const settingsCall = customCalls.at(-1);
	if (!settingsCall) {
		assert("global settings overlay opened", false);
	} else {
		const settingsComp = settingsCall.component as { render(w: number): string[]; handleInput?: (d: string) => void };
		const settingsText = strip(settingsComp.render(90).join("\n"));
		assert(
			"global settings overlay opened",
			settingsText.includes("Global Kanade Settings"),
			`settings: ${settingsText.slice(0, 300)}`,
		);
		assert(
			"settings overlay shows config",
			settingsText.includes("Config:"),
			`settings: ${settingsText.slice(0, 300)}`,
		);
		settingsComp.handleInput?.("\x1b");
		settingsCall.resolve(null);
	}
}

// ---------- Test 14: Sanitize text collapses newlines ----------
{
	console.log("\nTest 14: sanitizeText collapses newlines and control chars");
	// Access sanitizeText indirectly via review rendering with multiline content
	// The REVIEW_BLOCKED mock has a blocker with "Task is waiting for human input"
	// which is already single-line. We verify the panel doesn't contain raw \n \t.
	const panel = await createPanel();
	// Select T-0004 (blocked) and open detail
	panel.handleInput("/");
	for (const ch of "T-0004") panel.handleInput(ch);
	panel.handleInput("\r");
	await delay(200);
	const output = panel.render(120);
	const text = strip(output.join("\n"));
	// Verify no raw tab characters leak into output
	assert("no raw tabs in panel output", !text.includes("\t"), `found tab in: ${text.slice(0, 500)}`);
	// Verify review content is present
	// Verify review content is present — in narrow mode the detail shows task info
	// We just verify no raw control chars leaked and the panel rendered successfully
	assert("panel rendered for blocked task", text.length > 100, `output too short: ${text.length}`);
}

// ---------- Test 15: Events tab shows server events ----------
{
	console.log("\nTest 15: Events tab shows server events from SSE replay");
	customCalls.length = 0;
	const panel = await createPanel();
	await delay(300);
	// Select T-0001 and navigate to Events tab (Tab once from Map)
	panel.handleInput("/");
	for (const ch of "T-0001") panel.handleInput(ch);
	panel.handleInput("\r");
	await delay(150);
	// Dismiss action menu
	const actionCall = customCalls.at(-1);
	if (actionCall) {
		const overlayComp = actionCall.component as { handleInput?: (d: string) => void };
		overlayComp?.handleInput?.("\x1b");
		actionCall.resolve(null);
	}
	await delay(200);
	// Navigate to Events tab
	panel.handleInput("\t"); // Map -> Agent
	panel.handleInput("\t"); // Agent -> Events
	await delay(300);
	// Let detail load with events
	await delay(500);
	const output = panel.render(120);
	const text = strip(output.join("\n"));
	assert("Events tab selected", text.includes("[Events]"), `output: ${text.slice(0, 500)}`);
	assert("shows event type task.created", text.includes("task.created"), `output: ${text.slice(0, 800)}`);
	assert("shows event type task.running", text.includes("task.running"), `output: ${text.slice(0, 800)}`);
	assert("shows workflow.phase event", text.includes("workflow.phase"), `output: ${text.slice(0, 800)}`);
	assert(
		"shows event time stamps",
		/\d{2}:\d{2}:\d{2}/.test(text) || text.includes("ago"),
		`no timestamps in: ${text.slice(0, 500)}`,
	);
}

// ---------- Test 16: Events tab for empty events ----------
{
	console.log("\nTest 16: Events tab for task with no events");
	customCalls.length = 0;
	const panel = await createPanel();
	await delay(300);
	panel.handleInput("/");
	for (const ch of "T-0005") panel.handleInput(ch);
	panel.handleInput("\r");
	await delay(150);
	const actionCall = customCalls.at(-1);
	if (actionCall) {
		const overlayComp = actionCall.component as { handleInput?: (d: string) => void };
		overlayComp?.handleInput?.("\x1b");
		actionCall.resolve(null);
	}
	await delay(200);
	panel.handleInput("\t");
	panel.handleInput("\t");
	await delay(500);
	const output = panel.render(120);
	const text = strip(output.join("\n"));
	assert(
		"empty events shows status message",
		text.includes("No server events") || text.includes("Status:"),
		`output: ${text.slice(0, 500)}`,
	);
}

// ---------- Test 17: Agent Detail shows timing fields ----------
{
	console.log("\nTest 17: Agent Detail shows timing fields");
	customCalls.length = 0;
	const panel = await createPanel();
	await delay(300);
	// Select T-0001 (running task) and open agent detail
	panel.handleInput("/");
	for (const ch of "T-0001") panel.handleInput(ch);
	panel.handleInput("\r");
	await delay(150);
	const actionCall = customCalls.at(-1);
	if (actionCall) {
		const overlayComp = actionCall.component as { handleInput?: (d: string) => void };
		overlayComp?.handleInput?.("\x1b");
		actionCall.resolve(null);
	}
	await delay(150);
	// Open Agent Detail overlay
	customCalls.length = 0;
	panel.handleInput("f");
	await delay(800);
	const detailEntry = customCalls.at(-1);
	if (!detailEntry) {
		assert("Agent Detail overlay opened for timing", false, "ui.custom not called");
	} else {
		const detailComp = detailEntry.component as { render(w: number): string[] };
		await delay(500);
		const detailText = strip(detailComp.render(100).join("\n"));
		assert("shows started timing", detailText.includes("started"), `output: ${detailText.slice(0, 500)}`);
		assert("shows elapsed timing", detailText.includes("elapsed"), `output: ${detailText.slice(0, 500)}`);
		assert("shows last activity", detailText.includes("last activity"), `output: ${detailText.slice(0, 500)}`);
		// Clean up
		(detailComp as { handleInput?: (d: string) => void }).handleInput?.("\x1b");
		detailEntry.resolve(undefined);
	}
}

// ---------- Test 17b: Total task duration in detail header ----------
{
	console.log("\nTest 17b: Total task duration shown in detail header");
	customCalls.length = 0;
	const panel = await createPanel();
	await delay(300);
	// Select T-0003 (finished/merged task) which has created_at, started_at, finished_at
	panel.handleInput("/");
	for (const ch of "T-0003") panel.handleInput(ch);
	await delay(200);
	const output = panel.render(120);
	const text = strip(output.join("\n"));
	assert("detail header shows duration", /finished.*\d+[smh]/.test(text), `output: ${text.slice(0, 500)}`);
	// Also check running task shows elapsed
	customCalls.length = 0;
	const panel2 = await createPanel();
	await delay(300);
	panel2.handleInput("/");
	for (const ch of "T-0001") panel2.handleInput(ch);
	await delay(200);
	// Render wide enough so the right-aligned status isn't truncated
	const output2 = panel2.render(160);
	const text2 = strip(output2.join("\n"));
	assert("running task shows elapsed in header", text2.includes("elapsed"), `output: ${text2.slice(0, 800)}`);
}

// ---------- Test 17c: Per-agent duration in Map workflow plan ----------
{
	console.log("\nTest 17c: Per-agent duration shown in Map workflow plan");
	customCalls.length = 0;
	const panel = await createPanel();
	await delay(300);
	// T-0001 has a workflow plan with graph nodes that have timestamps
	panel.handleInput("/");
	for (const ch of "T-0001") panel.handleInput(ch);
	await delay(300);
	const output = panel.render(120);
	const text = strip(output.join("\n"));
	assert(
		"Map shows agent duration or elapsed",
		/elapsed \d+[smh]|done · \d+[smh]|✓.*\d+[smh]|\d+[smh]/.test(text),
		`output: ${text.slice(0, 800)}`,
	);
}

// ---------- Test 17d: Agent timing table in Agent tab ----------
{
	console.log("\nTest 17d: Agent timing table in Agent tab");
	customCalls.length = 0;
	const panel = await createPanel();
	await delay(300);
	// Select T-0003 (merged, has graph with done agents)
	panel.handleInput("/");
	for (const ch of "T-0003") panel.handleInput(ch);
	panel.handleInput("\r");
	await delay(150);
	const actionCall = customCalls.at(-1);
	if (actionCall) {
		const overlayComp = actionCall.component as { handleInput?: (d: string) => void };
		overlayComp?.handleInput?.("\x1b");
		actionCall.resolve(null);
	}
	await delay(150);
	// Navigate to Agent tab
	panel.handleInput("\t");
	await delay(400);
	const output = panel.render(120);
	const text = strip(output.join("\n"));
	assert("Agent tab selected", text.includes("[Agent]"), `output: ${text.slice(0, 500)}`);
	assert("shows Agent Timing section", text.includes("Agent Timing"), `output: ${text.slice(0, 800)}`);
	assert("shows agent name in timing", text.includes("implement-agent"), `output: ${text.slice(0, 800)}`);
	assert("shows done status in timing", text.includes("done"), `output: ${text.slice(0, 800)}`);
	assert("shows duration in timing table", /\d+m \d+s/.test(text), `output: ${text.slice(0, 800)}`);
}

// ---------- Test 18: No braille spinner characters in output ----------
{
	console.log("\nTest 18: no braille spinner characters in rendered output");
	const braillePattern = /[\u2800-\u28FF]/;
	const panel = await createPanel();
	await delay(300);
	const wideOutput = panel.render(120);
	const wideText = strip(wideOutput.join("\n"));
	assert("no braille in wide render", !braillePattern.test(wideText), `found braille in: ${wideText.slice(0, 300)}`);
	const narrowOutput = panel.render(80);
	const narrowText = strip(narrowOutput.join("\n"));
	assert(
		"no braille in narrow render",
		!braillePattern.test(narrowText),
		`found braille in: ${narrowText.slice(0, 300)}`,
	);
	// Also check agent detail overlay
	customCalls.length = 0;
	const cmd = commands.find((c) => c.name === "kanade");
	const cmdCtx = createFakeContext();
	void cmd.handler("", cmdCtx);
	await delay(250);
	const freshPanel = customCalls.at(-1)?.component as {
		render(w: number): string[];
		handleInput(d: string): void;
	};
	if (freshPanel) {
		freshPanel.handleInput("/");
		for (const ch of "T-0001") freshPanel.handleInput(ch);
		freshPanel.handleInput("\r");
		await delay(150);
		const ac = customCalls.at(-1);
		if (ac) {
			(ac.component as { handleInput?: (d: string) => void })?.handleInput?.("\x1b");
			ac.resolve(null);
		}
		await delay(150);
		customCalls.length = 0;
		freshPanel.handleInput("f");
		await delay(800);
		const de = customCalls.at(-1);
		if (de) {
			const dc = de.component as { render(w: number): string[] };
			await delay(500);
			const agentText = strip(dc.render(100).join("\n"));
			assert("no braille in agent detail", !braillePattern.test(agentText), "found braille in agent detail");
			(dc as { handleInput?: (d: string) => void }).handleInput?.("\x1b");
			de.resolve(undefined);
		}
	}
}

// ---------- Test 19: Footer status has no braille ----------
{
	console.log("\nTest 19: footer status text uses static labels");
	const panel = await createPanel();
	const output = panel.render(120);
	const text = strip(output.join("\n"));
	const braillePattern = /[\u2800-\u28FF]/;
	assert("header line has no braille", !braillePattern.test(text.split("\n")[0] ?? ""), "found braille in header");
	assert("header shows 'running' text", text.includes("running"), `missing running label in: ${text.slice(0, 300)}`);
}

// ---------- Test 20: Settings overlay shows editable field labels ----------
{
	console.log("\nTest 20: Settings overlay shows editable field labels and current values");
	const savedConfig = structuredClone(MOCK_CONFIG);
	customCalls.length = 0;
	const panel = await createPanel();
	panel.handleInput("s");
	await delay(200);
	const settingsCall = customCalls.at(-1);
	if (!settingsCall) {
		assert("settings overlay opened for edit test", false);
	} else {
		const comp = settingsCall.component as TestComponent;
		const text = strip(comp.render(90).join("\n"));
		assert("shows collapsed Defaults group", text.includes("[+] Defaults"), `output: ${text.slice(0, 500)}`);
		assert("shows expanded Models group", text.includes("[-] Models"), `output: ${text.slice(0, 500)}`);
		assert("shows Inherit Pi Settings label", text.includes("Inherit Pi Settings"), `output: ${text.slice(0, 500)}`);
		assert("can reveal Max Concurrent Tasks", await selectSettingsField(comp, "Defaults", "Max Concurrent Tasks"));
		assert("can reveal Role Models", await selectSettingsField(comp, "Defaults", "Role Models"));
		assert("can reveal Isolation Mode", await selectSettingsField(comp, "Isolation", "Isolation Mode"));
		assert("can reveal Persist Subagents", await selectSettingsField(comp, "Debug", "Persist Subagents"));
		assert("can reveal Cleanup Enabled", await selectSettingsField(comp, "Cleanup", "Cleanup Enabled"));
		assert("can reveal Auth Path read-only field", await selectSettingsField(comp, "Read-only", "Auth Path"));
		const readOnlyText = strip(comp.render(90).join("\n"));
		assert(
			"shows read-only marker for authPath",
			readOnlyText.includes("[read-only]"),
			`output: ${readOnlyText.slice(0, 500)}`,
		);
		assert(
			"shows current boolean value",
			readOnlyText.includes("false") || readOnlyText.includes("true"),
			`output: ${readOnlyText.slice(0, 500)}`,
		);
		assert("shows select hint", readOnlyText.includes("select"), `output: ${readOnlyText.slice(0, 500)}`);
		comp.handleInput?.("\x1b");
		settingsCall.resolve(undefined);
	}
	Object.assign(MOCK_CONFIG, savedConfig);
}

// ---------- Test 21: Settings toggle boolean ----------
{
	console.log("\nTest 21: Settings toggle boolean via Enter");
	const savedConfig = structuredClone(MOCK_CONFIG);
	customCalls.length = 0;
	fetchCalls.length = 0;
	patchBodies.length = 0;
	const panel = await createPanel(true); // confirmResult = true
	panel.handleInput("s");
	await delay(200);
	const settingsCall = customCalls.at(-1);
	if (!settingsCall) {
		assert("settings overlay opened for toggle test", false);
	} else {
		const comp = settingsCall.component as TestComponent;
		assert("selected Persist Subagents", await selectSettingsField(comp, "Debug", "Persist Subagents"));
		await delay(50);
		comp.handleInput?.("\r"); // Enter to toggle
		await delay(200);
		const text = strip(comp.render(90).join("\n"));
		assert(
			"shows saved confirmation after toggle",
			text.includes("Saved") || text.includes("persistSubagents"),
			`output: ${text.slice(0, 500)}`,
		);
		assert(
			"PATCH was called",
			fetchCalls.some((c) => c.includes("PATCH") && c.includes("/config")),
			`calls: ${fetchCalls.join(", ")}`,
		);
		assert(
			"PATCH uses nested config body",
			Boolean((patchBodies.at(-1)?.debug as Record<string, unknown> | undefined)?.persistSubagents),
			`patch: ${JSON.stringify(patchBodies.at(-1))}`,
		);
		comp.handleInput?.("\x1b");
		settingsCall.resolve(undefined);
	}
	Object.assign(MOCK_CONFIG, savedConfig);
}

// ---------- Test 22: Settings number edit mode ----------
{
	console.log("\nTest 22: Settings number edit mode via Enter");
	const savedConfig = structuredClone(MOCK_CONFIG);
	customCalls.length = 0;
	fetchCalls.length = 0;
	patchBodies.length = 0;
	const panel = await createPanel();
	panel.handleInput("s");
	await delay(200);
	const settingsCall = customCalls.at(-1);
	if (!settingsCall) {
		assert("settings overlay opened for number edit", false);
	} else {
		const comp = settingsCall.component as TestComponent;
		assert("selected Max Concurrent Tasks", await selectSettingsField(comp, "Defaults", "Max Concurrent Tasks"));
		await delay(50);
		// Enter edit mode
		comp.handleInput?.("\r");
		await delay(50);
		let text = strip(comp.render(90).join("\n"));
		assert(
			"shows edit mode indicator",
			text.includes("Editing") || text.includes("▏"),
			`output: ${text.slice(0, 500)}`,
		);
		// Type a new value
		for (const ch of "5") comp.handleInput?.(ch);
		comp.handleInput?.("\r"); // Enter to save
		await delay(200);
		text = strip(comp.render(90).join("\n"));
		assert(
			"shows saved after number edit",
			text.includes("Saved") || text.includes("maxConcurrentTasks"),
			`output: ${text.slice(0, 500)}`,
		);
		assert(
			"PATCH was called for number",
			fetchCalls.some((c) => c.includes("PATCH")),
			`calls: ${fetchCalls.join(", ")}`,
		);
		assert(
			"number PATCH uses nested defaults body",
			(patchBodies.at(-1)?.defaults as Record<string, unknown> | undefined)?.maxConcurrentTasks === 5,
			`patch: ${JSON.stringify(patchBodies.at(-1))}`,
		);
		comp.handleInput?.("\x1b");
		settingsCall.resolve(undefined);
	}
	Object.assign(MOCK_CONFIG, savedConfig);
}

// ---------- Test 23: Settings dangerous field requires confirmation ----------
{
	console.log("\nTest 23: Settings dangerous cleanup field requires confirmation");
	const savedConfig = structuredClone(MOCK_CONFIG);
	customCalls.length = 0;
	fetchCalls.length = 0;
	patchBodies.length = 0;
	// confirmResult = false means the confirmation dialog will be rejected
	const panel = await createPanel(false);
	panel.handleInput("s");
	await delay(200);
	const settingsCall = customCalls.at(-1);
	if (!settingsCall) {
		assert("settings overlay opened for dangerous test", false);
	} else {
		const comp = settingsCall.component as TestComponent;
		assert("selected Cleanup Enabled", await selectSettingsField(comp, "Cleanup", "Cleanup Enabled"));
		await delay(50);
		comp.handleInput?.("\r"); // Enter to toggle
		await delay(50);
		comp.handleInput?.("\x1b"); // reject inline confirmation
		await delay(300);
		const text = strip(comp.render(90).join("\n"));
		assert(
			"shows cancelled notice for rejected dangerous toggle",
			text.includes("Cancelled"),
			`output: ${text.slice(0, 500)}`,
		);
		assert(
			"PATCH not called when confirm rejected",
			!fetchCalls.some((c) => c.includes("PATCH")),
			`calls: ${fetchCalls.join(", ")}`,
		);
		comp.handleInput?.("\x1b");
		settingsCall.resolve(undefined);
	}
	Object.assign(MOCK_CONFIG, savedConfig);
}

// ---------- Test 24: Settings Esc in edit mode cancels ----------
{
	console.log("\nTest 24: Settings Esc in edit mode cancels without saving");
	const savedConfig = structuredClone(MOCK_CONFIG);
	customCalls.length = 0;
	fetchCalls.length = 0;
	const panel = await createPanel();
	panel.handleInput("s");
	await delay(200);
	const settingsCall = customCalls.at(-1);
	if (!settingsCall) {
		assert("settings overlay opened for cancel test", false);
	} else {
		const comp = settingsCall.component as TestComponent;
		assert("selected Agent Timeout Ms", await selectSettingsField(comp, "Defaults", "Agent Timeout Ms"));
		await delay(50);
		// Enter edit mode
		comp.handleInput?.("\r");
		await delay(50);
		// Type some chars then cancel
		for (const ch of "999") comp.handleInput?.(ch);
		comp.handleInput?.("\x1b"); // Esc to cancel
		await delay(100);
		const text = strip(comp.render(90).join("\n"));
		assert(
			"PATCH not called when edit cancelled",
			!fetchCalls.some((c) => c.includes("PATCH")),
			`calls: ${fetchCalls.join(", ")}`,
		);
		assert("back to normal mode (select hint visible)", text.includes("select"), `output: ${text.slice(0, 500)}`);
		comp.handleInput?.("\x1b");
		settingsCall.resolve(undefined);
	}
	Object.assign(MOCK_CONFIG, savedConfig);
}

// ---------- Test 25: Settings groups render section headers + model fields + read-only markers ----------
{
	console.log("\nTest 25: Settings groups render section headers, model fields, read-only markers");
	const savedConfig = structuredClone(MOCK_CONFIG);
	customCalls.length = 0;
	const panel = await createPanel();
	panel.handleInput("s");
	await delay(200);
	const settingsCall = customCalls.at(-1);
	if (!settingsCall) {
		assert("settings overlay opened for group test", false);
	} else {
		const comp = settingsCall.component as TestComponent;
		const text = strip(comp.render(90).join("\n"));
		assert("shows Models group header", text.includes("Models"), `output: ${text.slice(0, 500)}`);
		assert("shows Defaults group header", text.includes("Defaults"), `output: ${text.slice(0, 500)}`);
		assert("shows Isolation group header", text.includes("Isolation"), `output: ${text.slice(0, 500)}`);
		assert("shows Merge group header", text.includes("Merge"), `output: ${text.slice(0, 500)}`);
		assert("shows Debug group header", text.includes("Debug"), `output: ${text.slice(0, 500)}`);
		assert("shows Cleanup group header", text.includes("Cleanup"), `output: ${text.slice(0, 500)}`);
		assert("shows Network group header", text.includes("Network"), `output: ${text.slice(0, 500)}`);
		assert("shows Live Acceptance group header", text.includes("Live Acceptance"), `output: ${text.slice(0, 500)}`);
		assert(
			"shows read-only section header",
			text.includes("Read-only") || text.includes("Sensitive"),
			`output: ${text.slice(0, 500)}`,
		);
		assert("starts with non-model groups collapsed", text.includes("[+] Defaults"), `output: ${text.slice(0, 500)}`);
		assert("shows Models Path in models section", text.includes("Models Path"), `output: ${text.slice(0, 500)}`);
		assert(
			"shows Disable Subagent Compaction label",
			text.includes("Disable Subagent Compaction"),
			`output: ${text.slice(0, 500)}`,
		);
		assert("can reveal Role Models label", await selectSettingsField(comp, "Defaults", "Role Models"));
		assert("can reveal HTTP Proxy label", await selectSettingsField(comp, "Network", "HTTP Proxy"));
		assert("can reveal HTTP Idle Timeout label", await selectSettingsField(comp, "Network", "HTTP Idle Timeout"));
		assert(
			"can reveal Timeout Ms in Live Acceptance",
			await selectSettingsField(comp, "Live Acceptance", "Timeout Ms"),
		);
		assert("can reveal Poll Ms in Live Acceptance", await selectSettingsField(comp, "Live Acceptance", "Poll Ms"));
		assert("can reveal Port in read-only section", await selectSettingsField(comp, "Read-only", "Port"));
		assert("can reveal DB Dir in read-only section", await selectSettingsField(comp, "Read-only", "DB Dir"));
		assert(
			"can reveal Worktrees Dir in read-only section",
			await selectSettingsField(comp, "Read-only", "Worktrees Dir"),
		);
		const readOnlyText = strip(comp.render(90).join("\n"));
		assert(
			"shows read-only marker for blocked field",
			readOnlyText.includes("[read-only]"),
			`output: ${readOnlyText.slice(0, 500)}`,
		);
		assert(
			"shows role=model value for roleModels",
			(await selectSettingsField(comp, "Defaults", "Role Models")) &&
				strip(comp.render(90).join("\n")).includes("implement=claude-sonnet-4"),
			`output: ${strip(comp.render(90).join("\n")).slice(0, 500)}`,
		);
		comp.handleInput?.("\x1b");
		settingsCall.resolve(undefined);
	}
	Object.assign(MOCK_CONFIG, savedConfig);
}

// ---------- Test 25b: Settings search, raw config, and restart hints ----------
{
	console.log("\nTest 25b: Settings search, raw config, and restart hints");
	customCalls.length = 0;
	const panel = await createPanel();
	panel.handleInput("s");
	await delay(200);
	const settingsCall = customCalls.at(-1);
	if (!settingsCall) {
		assert("settings overlay opened for search/raw test", false);
	} else {
		const comp = settingsCall.component as TestComponent;
		let text = strip(comp.render(100).join("\n"));
		assert("shows restart hint", text.includes("[restart]"), `output: ${text.slice(0, 600)}`);
		assert("shows live hint", text.includes("[live]"), `output: ${text.slice(0, 600)}`);
		comp.handleInput?.("/");
		for (const ch of "proxy") comp.handleInput?.(ch);
		text = strip(comp.render(100).join("\n"));
		assert("search prompt visible", text.includes("Search: proxy"), `output: ${text.slice(0, 600)}`);
		assert("search finds proxy fields", text.includes("HTTP Proxy"), `output: ${text.slice(0, 600)}`);
		assert("search filters unrelated fields", !text.includes("Max Concurrent Tasks"), `output: ${text.slice(0, 600)}`);
		const selectedBefore = text.match(/▸\s+([^\n]+)/)?.[1] ?? "";
		comp.handleInput?.("\x1b[B");
		text = strip(comp.render(100).join("\n"));
		const selectedAfter = text.match(/▸\s+([^\n]+)/)?.[1] ?? "";
		assert(
			"search mode down arrow moves selection",
			Boolean(selectedBefore) && Boolean(selectedAfter) && selectedBefore !== selectedAfter,
			`before=${selectedBefore} after=${selectedAfter} output: ${text.slice(0, 600)}`,
		);
		comp.handleInput?.("\r");
		text = strip(comp.render(100).join("\n"));
		assert("search result enter starts editing", text.includes("Editing"), `output: ${text.slice(0, 600)}`);
		comp.handleInput?.("\x1b");
		comp.handleInput?.("\x1b");
		text = strip(comp.render(100).join("\n"));
		assert("search clear restores groups", text.includes("[+] Defaults"), `output: ${text.slice(0, 600)}`);
		comp.handleInput?.("r");
		text = strip(comp.render(100).join("\n"));
		assert("raw config view opens", text.includes("Raw config view"), `output: ${text.slice(0, 600)}`);
		assert("raw config shows json", text.includes('"paths"'), `output: ${text.slice(0, 600)}`);
		comp.handleInput?.("r");
		text = strip(comp.render(100).join("\n"));
		assert("raw config view closes", text.includes("Global Kanade Settings") && !text.includes("Raw config view"));
		comp.handleInput?.("\x1b");
		settingsCall.resolve(undefined);
	}
}

// ---------- Test 26: Edit roleModels using role=model lines ----------
{
	console.log("\nTest 26: Edit roleModels using role=model lines");
	const savedConfig = structuredClone(MOCK_CONFIG);
	customCalls.length = 0;
	fetchCalls.length = 0;
	patchBodies.length = 0;
	const panel = await createPanel();
	panel.handleInput("s");
	await delay(200);
	const settingsCall = customCalls.at(-1);
	if (!settingsCall) {
		assert("settings overlay opened for roleModels edit test", false);
	} else {
		const comp = settingsCall.component as TestComponent;
		assert("selected Role Models", await selectSettingsField(comp, "Defaults", "Role Models"));
		comp.handleInput?.("\r");
		await delay(50);
		let text = strip(comp.render(90).join("\n"));
		assert("shows role=model editor", text.includes("implement=claude-sonnet-4"), `output: ${text.slice(0, 500)}`);
		assert("shows role editor hint", text.includes("role=model"), `output: ${text.slice(0, 500)}`);
		comp.handleInput?.("\x1b[A"); // move cursor from the last role to the first role
		comp.handleInput?.("\x1b[F"); // move to the end of that role line
		comp.handleInput?.("\r");
		for (const ch of "qa=gpt-5.4") comp.handleInput?.(ch);
		comp.handleInput?.("\x13"); // Ctrl+S
		await delay(200);
		text = strip(comp.render(90).join("\n"));
		assert("shows saved after roleModels edit", text.includes("Saved"), `output: ${text.slice(0, 500)}`);
		const roleModels = (patchBodies.at(-1)?.defaults as Record<string, unknown> | undefined)?.roleModels as
			| Record<string, string>
			| undefined;
		assert("roleModels PATCH keeps existing implement role", roleModels?.implement === "claude-sonnet-4");
		assert(
			"roleModels PATCH adds qa role",
			roleModels?.qa === "gpt-5.4",
			`patch: ${JSON.stringify(patchBodies.at(-1))}`,
		);
		assert(
			"up arrow inserts qa before review role",
			Object.keys(roleModels ?? {}).join(",") === "implement,qa,review",
			`patch: ${JSON.stringify(patchBodies.at(-1))}`,
		);
		comp.handleInput?.("\x1b");
		settingsCall.resolve(undefined);
	}
	Object.assign(MOCK_CONFIG, savedConfig);
}

// ---------- Test 27: Edit model default field (authorModel) with correct PATCH shape ----------
{
	console.log("\nTest 27: Edit model default field (authorModel) with correct PATCH shape");
	const savedConfig = structuredClone(MOCK_CONFIG);
	customCalls.length = 0;
	fetchCalls.length = 0;
	patchBodies.length = 0;
	const panel = await createPanel();
	panel.handleInput("s");
	await delay(200);
	const settingsCall = customCalls.at(-1);
	if (!settingsCall) {
		assert("settings overlay opened for model edit test", false);
	} else {
		const comp = settingsCall.component as TestComponent;
		assert("selected Author Model", await selectSettingsField(comp, "Defaults", "Author Model"));
		await delay(50);
		// Enter edit mode
		comp.handleInput?.("\r");
		await delay(50);
		let text = strip(comp.render(90).join("\n"));
		assert(
			"shows edit mode indicator",
			text.includes("Editing") || text.includes("▏"),
			`output: ${text.slice(0, 500)}`,
		);
		// Clear existing value then type new value
		for (let i = 0; i < 10; i++) comp.handleInput?.("\x7f"); // DEL = backspace
		for (const ch of "claude-opus-4") comp.handleInput?.(ch);
		comp.handleInput?.("\r"); // Enter to save
		await delay(200);
		text = strip(comp.render(90).join("\n"));
		assert(
			"shows saved after authorModel edit",
			text.includes("Saved") || text.includes("authorModel"),
			`output: ${text.slice(0, 500)}`,
		);
		assert(
			"PATCH was called for authorModel",
			fetchCalls.some((c) => c.includes("PATCH")),
			`calls: ${fetchCalls.join(", ")}`,
		);
		assert(
			"authorModel PATCH uses nested defaults body",
			(patchBodies.at(-1)?.defaults as Record<string, unknown> | undefined)?.authorModel === "claude-opus-4",
			`patch: ${JSON.stringify(patchBodies.at(-1))}`,
		);
		comp.handleInput?.("\x1b");
		settingsCall.resolve(undefined);
	}
	Object.assign(MOCK_CONFIG, savedConfig);
}

console.log(`\n${"=".repeat(50)}`);
console.log(`Smoke results: ${passed} passed, ${failed} failed`);

// Clean up timers so Node can exit (extension creates setInterval timers)
process.exit(failed > 0 ? 1 : 0);
