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
		diff_stat: "2 files changed, 12 insertions(+)",
		changed_files_count: 2,
		commit_count: 2,
		has_changes: true,
	},
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
};

const SCRIPT = 'phase("implement")\nawait implement("fix the bug")\n';

const USAGE: Record<string, unknown> = {
	input: 1000,
	output: 500,
	totalTokens: 1500,
	cost: { total: 0.05 },
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

function mockFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
	const raw = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
	const method = init?.method ?? "GET";
	fetchCalls.push(`${method} ${raw}`);
	const path = new URL(raw).pathname;

	const json = (data: unknown, status = 200) =>
		new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

	if (path === "/health") return json({ ok: true });
	if (path === "/tasks" && method === "GET") return json({ tasks: [TASK, TASK_FAILED, TASK_MERGED] });
	if (path === "/inbox") return json({ requests: [] });
	if (/^\/tasks\/T-0001\/snapshot$/.test(path)) return json({ snapshot: SNAPSHOT });
	if (/^\/tasks\/T-0001\/script$/.test(path)) return json({ script: SCRIPT });
	if (/^\/tasks\/T-0001\/worktrees$/.test(path)) return json({ worktrees: WORKTREES });
	if (/^\/tasks\/T-0001\/sessions$/.test(path)) return json({ sessions: SESSIONS });
	if (/^\/tasks\/T-0001$/.test(path) && method === "GET") return json({ task: TASK, usage: USAGE });
	if (/^\/tasks\/T-0003\/snapshot$/.test(path))
		return json({ snapshot: { ...SNAPSHOT, name: "merged-workflow", agents: [] } });
	if (/^\/tasks\/T-0003\/script$/.test(path)) return json({ script: SCRIPT });
	if (/^\/tasks\/T-0003\/worktrees$/.test(path)) return json({ worktrees: WORKTREES_MERGED });
	if (/^\/tasks\/T-0003\/sessions$/.test(path)) return json({ sessions: [] });
	if (/^\/tasks\/T-0003$/.test(path) && method === "GET") return json({ task: TASK_MERGED, usage: USAGE });

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

function createFakeContext(overrides?: { mode?: string }) {
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
			confirm: async () => false,
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
async function createPanel() {
	const cmd = commands.find((c) => c.name === "kanade");
	if (!cmd) throw new Error("kanade command not registered");
	// Fire the handler; it will call ui.custom internally
	const cmdCtx = createFakeContext();
	void cmd.handler("", cmdCtx);
	// Let the async handler reach ui.custom and the panel constructor + refresh settle
	await delay(250);
	const entry = customCalls.at(-1);
	if (!entry) throw new Error("ui.custom was not called – KanadePanel was not created");
	return entry.component as { render(w: number): string[]; handleInput(d: string): void };
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

// ---------------------------------------------------------------------------
// 5. Summary
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(50)}`);
console.log(`Smoke results: ${passed} passed, ${failed} failed`);

// Clean up timers so Node can exit (extension creates setInterval timers)
process.exit(failed > 0 ? 1 : 0);
