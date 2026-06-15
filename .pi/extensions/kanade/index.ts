import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

type TaskStatus = "created" | "running" | "needs_human" | "finished" | "aborted" | "failed";
type Theme = ExtensionCommandContext["ui"]["theme"];
type Ui = ExtensionCommandContext["ui"];
type TuiHandle = { requestRender(): void };

type ServerEvent = { id: number; type: string; taskId?: string; data: unknown; ts: number };
const TASK_EVENT_TYPES = [
	"task.created",
	"task.running",
	"task.finished",
	"task.failed",
	"task.aborted",
	"task.needs_human",
	"task.human_resolved",
	"task.merged",
	"task.rejected",
	"task.script_generated",
	"workflow.phase",
	"workflow.agent_started",
	"workflow.agent_completed",
	"workflow.log",
];
type TaskEvent = { time: string; type: string; summary: string; ts: number };
type AgentTiming = { startedAt?: number; elapsedMs?: number; lastActivityAt?: number; idleMs?: number };

type Component = {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate(): void;
};

type WorktreeSummary = {
	status?: "none" | "active" | "inactive" | "merged" | "preserved" | "rejected" | string;
	count?: number;
	branch?: string;
	path?: string;
	merge_commit?: string;
	has_changes?: boolean;
	changed_files_count?: number;
	commit_count?: number;
	diff_stat?: string;
};

type KanadeTask = {
	id: string;
	status: TaskStatus | string;
	workflow_source?: string;
	workflow_name?: string | null;
	workflow_path?: string;
	base_repo?: string | null;
	base_branch?: string;
	cwd?: string;
	created_at?: number;
	started_at?: number | null;
	finished_at?: number | null;
	error?: string | null;
	result?: string | null;
	worktree_summary?: WorktreeSummary;
};

type InboxRequest = {
	request_id: string;
	task_id: string;
	cache_key?: string;
	payload?: { title?: string; detail?: string; options?: string[]; data?: Record<string, unknown> };
	status?: string;
	created_at?: number;
	resolved_at?: number | null;
	response?: unknown;
};

type UsageAgent = {
	label?: string;
	phase?: string;
	role?: string;
	model?: string;
	status?: string;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
};

type UsageSummary = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
	author?: UsageSummary;
	runtime?: UsageSummary;
	total?: UsageSummary;
	agents?: UsageAgent[];
};

type WorkflowAgentSnapshot = {
	id: number;
	label: string;
	phase?: string;
	prompt: string;
	status: "queued" | "running" | "done" | "error" | "skipped" | string;
	resultPreview?: string;
	error?: string;
};

type WorkflowGraphNode = {
	id: string;
	kind: "phase" | "agent" | "human" | "terminal" | string;
	label: string;
	status: "planned" | "running" | "done" | "warning" | "error" | string;
	phase?: string;
	summary?: string;
	error?: string;
	createdAt?: number;
	updatedAt?: number;
};

type WorkflowGraphSnapshot = {
	nodes: WorkflowGraphNode[];
	edges: Array<{ id: string; from: string; to: string; label?: string; status?: string }>;
	cursorNodeId?: string;
};

type WorkflowSnapshot = {
	name: string;
	description?: string;
	phases: string[];
	currentPhase?: string;
	logs: string[];
	agents: WorkflowAgentSnapshot[];
	agentCount: number;
	runningCount: number;
	doneCount: number;
	errorCount: number;
	durationMs?: number;
	result?: unknown;
	graph?: WorkflowGraphSnapshot;
};

type WorktreeRow = {
	id: string;
	task_id: string;
	label: string;
	branch: string;
	base_branch: string;
	worktree_path: string;
	status: string;
	base_repo: string;
	created_at: number;
	last_used_at: number;
	finished_at: number | null;
	merge_commit: string | null;
};

type SessionListItem = { label: string; files: string[]; paths?: string[] };

type SessionEntry = {
	type?: string;
	timestamp?: string | number;
	message?: {
		role?: string;
		content?: Array<Record<string, unknown>>;
	};
	provider?: string;
	modelId?: string;
};

type SessionEvent = {
	time: string;
	rawTs?: number;
	label: string;
	summary: string;
	detail?: string;
	state?: "running" | "done" | "error" | "neutral";
};

type WorkflowPlanStep = {
	phase: string;
	helper: string;
	label: string;
	conditional: boolean;
};

type ReviewSummary = {
	task_id: string;
	status: string;
	state: string;
	mergeable: boolean;
	recommendation: string;
	blockers: string[];
	checks: Record<string, boolean>;
	workflow?: { source?: string; name?: string | null };
	worktree?: WorktreeSummary;
	review?: {
		agents?: { total?: number; done?: number; failed?: number };
		phases?: { completed?: number; in_progress?: number };
		human_gates?: { pending?: number; resolved?: number };
	};
	usage?: Record<string, unknown> | null;
	iteration_chain?: string[];
	created_at?: number;
	started_at?: number | null;
	finished_at?: number | null;
};

// Sanitize text for safe single-line rendering: strip control chars and collapse whitespace
function sanitizeText(text: unknown): string {
	if (typeof text !== "string") return String(text ?? "");
	return Array.from(text)
		.filter((char) => {
			const code = char.charCodeAt(0);
			return code >= 32 || code === 9 || code === 10 || code === 13;
		})
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

type TaskDetail = {
	loading: boolean;
	loadedAt?: number;
	error?: string;
	task?: KanadeTask;
	usage?: UsageSummary | null;
	snapshot?: WorkflowSnapshot | null;
	workflowScript?: string;
	workflowPlan?: WorkflowPlanStep[];
	worktrees?: WorktreeRow[];
	sessions?: SessionListItem[];
	sessionLabel?: string;
	sessionEvents?: SessionEvent[];
	taskEvents?: TaskEvent[];
	timing?: AgentTiming;
	review?: ReviewSummary | null;
};

type KanadeOverview = {
	connected: boolean;
	baseUrl: string;
	tasks: KanadeTask[];
	inbox: InboxRequest[];
	error?: string;
};

type TaskListView = {
	tasks: KanadeTask[];
	total: number;
	query: string;
};

type Tab = "Map" | "Agent" | "Events" | "Worktree" | "Usage" | "Result" | "Review";

type Counts = { running: number; needsHuman: number; failed: number; finished: number };

type ActionKey =
	| "respond"
	| "iterate"
	| "merge"
	| "reconcile"
	| "abort"
	| "reject"
	| "recovery"
	| "agent"
	| "refresh"
	| "settings";

type ActionItem = {
	key: ActionKey;
	label: string;
	danger?: boolean;
};

type ActiveOperation = {
	label: string;
	detail?: string;
	startedAt: number;
};

type RecoveryCleanupResult = {
	dry_run: boolean;
	matched: number;
	cleaned: number;
	tasks: Array<{ id?: string; worktree_summary?: WorktreeSummary }>;
};

type ConfirmDialog = {
	title: string;
	message: string;
	confirmLabel: string;
	danger?: boolean;
	onConfirm: () => Promise<void>;
};

const DEFAULT_BASE_URL = "http://127.0.0.1:7777";
const TABS: readonly Tab[] = ["Map", "Agent", "Events", "Worktree", "Usage", "Result", "Review"];
const PANEL_BODY_ROWS = 32;
const MAX_VISIBLE_TASKS = 10;
const MAX_VISIBLE_NARROW_TASKS = 5;
const MAX_VISIBLE_AGENT_EVENTS = 3;
const ESC = String.fromCharCode(27);
const CLEAR_CELL = "\u00A0";
const ANSI_SGR_PREFIX = new RegExp(`^${ESC}\\[[0-9;]*m`);
const ANSI_SGR_GLOBAL = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

type SettingsFieldType = "boolean" | "number" | "string" | "json" | "record";

type SettingsFieldDef = {
	key: string;
	section: string;
	label: string;
	type: SettingsFieldType;
	dangerous?: boolean;
	readOnly?: boolean;
};

type SettingsGroup = { section: string; label: string; fields: SettingsFieldDef[] };
type SettingsDisplayItem =
	| { kind: "section"; groupIndex: number; label: string; expanded: boolean; fieldCount: number }
	| { kind: "field"; groupIndex: number; field: SettingsFieldDef };

const SETTINGS_GROUPS: readonly SettingsGroup[] = [
	{
		section: "models",
		label: "Models",
		fields: [
			{ key: "models.modelsPath", section: "models", label: "Models Path", type: "string" },
			{ key: "models.inheritPiSettings", section: "models", label: "Inherit Pi Settings", type: "boolean" },
			{
				key: "models.disableSubagentCompaction",
				section: "models",
				label: "Disable Subagent Compaction",
				type: "boolean",
			},
		],
	},
	{
		section: "defaults",
		label: "Defaults",
		fields: [
			{ key: "defaults.maxConcurrentTasks", section: "defaults", label: "Max Concurrent Tasks", type: "number" },
			{ key: "defaults.concurrency", section: "defaults", label: "Concurrency", type: "number" },
			{ key: "defaults.agentTimeoutMs", section: "defaults", label: "Agent Timeout Ms", type: "number" },
			{ key: "defaults.authorModel", section: "defaults", label: "Author Model", type: "string" },
			{ key: "defaults.agentModel", section: "defaults", label: "Agent Model", type: "string" },
			{ key: "defaults.roleModels", section: "defaults", label: "Role Models", type: "record" },
		],
	},
	{
		section: "isolation",
		label: "Isolation",
		fields: [{ key: "isolation.defaultMode", section: "isolation", label: "Isolation Mode", type: "string" }],
	},
	{
		section: "merge",
		label: "Merge",
		fields: [{ key: "merge.targetBranch", section: "merge", label: "Target Branch", type: "string" }],
	},
	{
		section: "debug",
		label: "Debug",
		fields: [
			{ key: "debug.persistSubagents", section: "debug", label: "Persist Subagents", type: "boolean" },
			{ key: "debug.dumpArtifacts", section: "debug", label: "Dump Artifacts", type: "boolean" },
		],
	},
	{
		section: "cleanup",
		label: "Cleanup",
		fields: [
			{ key: "cleanup.enabled", section: "cleanup", label: "Cleanup Enabled", type: "boolean", dangerous: true },
			{ key: "cleanup.schedule", section: "cleanup", label: "Cleanup Schedule", type: "string", dangerous: true },
		],
	},
	{
		section: "network",
		label: "Network",
		fields: [
			{ key: "network.httpProxy", section: "network", label: "HTTP Proxy", type: "string" },
			{ key: "network.httpsProxy", section: "network", label: "HTTPS Proxy", type: "string" },
			{ key: "network.allProxy", section: "network", label: "All Proxy", type: "string" },
			{ key: "network.noProxy", section: "network", label: "No Proxy", type: "string" },
			{ key: "network.httpIdleTimeoutMs", section: "network", label: "HTTP Idle Timeout Ms", type: "number" },
		],
	},
	{
		section: "liveAcceptance",
		label: "Live Acceptance",
		fields: [
			{ key: "liveAcceptance.timeoutMs", section: "liveAcceptance", label: "Timeout Ms", type: "number" },
			{ key: "liveAcceptance.pollMs", section: "liveAcceptance", label: "Poll Ms", type: "number" },
		],
	},
	{
		section: "_readonly",
		label: "Read-only / Sensitive",
		fields: [
			{ key: "models.mode", section: "models", label: "Mode", type: "string", readOnly: true },
			{ key: "models.authPath", section: "models", label: "Auth Path", type: "string", readOnly: true },
			{ key: "models.agentDir", section: "models", label: "Agent Dir", type: "string", readOnly: true },
			{ key: "models.piAgentDir", section: "models", label: "Pi Agent Dir", type: "string", readOnly: true },
			{ key: "paths.root", section: "paths", label: "Root", type: "string", readOnly: true },
			{ key: "paths.configFile", section: "paths", label: "Config File", type: "string", readOnly: true },
			{ key: "paths.dbDir", section: "paths", label: "DB Dir", type: "string", readOnly: true },
			{ key: "paths.rolesDir", section: "paths", label: "Roles Dir", type: "string", readOnly: true },
			{ key: "paths.workflowsDir", section: "paths", label: "Workflows Dir", type: "string", readOnly: true },
			{ key: "paths.runsDir", section: "paths", label: "Runs Dir", type: "string", readOnly: true },
			{ key: "paths.worktreesDir", section: "paths", label: "Worktrees Dir", type: "string", readOnly: true },
			{ key: "paths.tracesDir", section: "paths", label: "Traces Dir", type: "string", readOnly: true },
			{ key: "paths.stateDb", section: "paths", label: "State DB", type: "string", readOnly: true },
			{ key: "paths.logsDir", section: "paths", label: "Logs Dir", type: "string", readOnly: true },
			{
				key: "paths.sharedExtensionsDir",
				section: "paths",
				label: "Shared Extensions Dir",
				type: "string",
				readOnly: true,
			},
			{ key: "server.port", section: "server", label: "Port", type: "number", readOnly: true },
			{ key: "server.bind", section: "server", label: "Bind", type: "string", readOnly: true },
		],
	},
];

function kanadeBaseUrl(): string {
	return (process.env.KANADE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
}

async function getJson<T>(path: string, timeoutMs = 5000): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${kanadeBaseUrl()}${path}`, { signal: controller.signal });
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`${res.status} ${res.statusText}${body ? ` · ${truncatePlain(body, 120)}` : ""}`);
		}
		return (await res.json()) as T;
	} finally {
		clearTimeout(timer);
	}
}

async function postJson<T>(path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${kanadeBaseUrl()}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: controller.signal,
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`${res.status} ${res.statusText}${text ? ` · ${truncatePlain(text, 180)}` : ""}`);
		}
		return (await res.json()) as T;
	} finally {
		clearTimeout(timer);
	}
}

async function patchJson<T>(path: string, body: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${kanadeBaseUrl()}${path}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`${res.status} ${res.statusText}${text ? ` · ${truncatePlain(text, 180)}` : ""}`);
		}
		return (await res.json()) as T;
	} finally {
		clearTimeout(timer);
	}
}

async function fetchTasksOverview(previousInbox: InboxRequest[] = []): Promise<KanadeOverview> {
	try {
		const tasksBody = await getJson<{ tasks: KanadeTask[] }>("/tasks");
		return {
			connected: true,
			baseUrl: kanadeBaseUrl(),
			tasks: sortTasks(tasksBody.tasks ?? []),
			inbox: previousInbox,
		};
	} catch (error) {
		return {
			connected: false,
			baseUrl: kanadeBaseUrl(),
			tasks: [],
			inbox: previousInbox,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function fetchInbox(): Promise<InboxRequest[]> {
	try {
		const inboxBody = await getJson<{ requests: InboxRequest[] }>("/inbox", 2000);
		return inboxBody.requests ?? [];
	} catch {
		return [];
	}
}

async function fetchOverview(): Promise<KanadeOverview> {
	const overview = await fetchTasksOverview();
	if (!overview.connected) return overview;
	return { ...overview, inbox: await fetchInbox() };
}

async function fetchTaskDetail(taskId: string, includeSession = false, includeEvents = false): Promise<TaskDetail> {
	const detail: TaskDetail = { loading: false, loadedAt: Date.now() };
	const [taskResult, snapshotResult, scriptResult, worktreesResult, sessionsResult, reviewResult] =
		await Promise.allSettled([
			getJson<{ task: KanadeTask; usage?: UsageSummary | null }>(`/tasks/${encodeURIComponent(taskId)}`),
			getJson<{ snapshot: WorkflowSnapshot }>(`/tasks/${encodeURIComponent(taskId)}/snapshot`),
			getJson<{ script: string }>(`/tasks/${encodeURIComponent(taskId)}/script`),
			getJson<{ worktrees: WorktreeRow[] }>(`/tasks/${encodeURIComponent(taskId)}/worktrees`),
			getJson<{ sessions: SessionListItem[] }>(`/tasks/${encodeURIComponent(taskId)}/sessions`),
			getJson<ReviewSummary>(`/tasks/${encodeURIComponent(taskId)}/review`),
		]);

	const errors: string[] = [];
	if (taskResult.status === "fulfilled") {
		detail.task = taskResult.value.task;
		detail.usage = taskResult.value.usage ?? null;
	} else {
		errors.push(`task: ${taskResult.reason}`);
	}

	if (includeEvents) {
		// Fetch task events (SSE replay) — best effort. Keep this opt-in so normal
		// detail loads and Agent Detail open do not wait on a long-lived SSE stream.
		try {
			detail.taskEvents = await fetchTaskEvents(taskId);
		} catch {
			// non-critical
		}
	}
	if (snapshotResult.status === "fulfilled") detail.snapshot = snapshotResult.value.snapshot;
	else detail.snapshot = null;
	if (scriptResult.status === "fulfilled") {
		detail.workflowScript = scriptResult.value.script;
		detail.workflowPlan = parseWorkflowPlan(scriptResult.value.script);
	}
	if (worktreesResult.status === "fulfilled") detail.worktrees = worktreesResult.value.worktrees ?? [];
	else detail.worktrees = [];
	if (sessionsResult.status === "fulfilled") detail.sessions = sessionsResult.value.sessions ?? [];
	else detail.sessions = [];
	if (reviewResult.status === "fulfilled") detail.review = reviewResult.value;
	else detail.review = null;

	if (includeSession && detail.sessions.length > 0) {
		const preferred = pickSession(detail.sessions);
		if (preferred) {
			try {
				const body = await getJson<{ label: string; entries: SessionEntry[]; file: string }>(
					`/tasks/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(preferred.label)}`,
				);
				detail.sessionLabel = body.label;
				detail.sessionEvents = summarizeSessionEntries(body.entries ?? []).slice(-40);
			} catch (error) {
				errors.push(`session: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	// Compute timing from available sources
	detail.timing = computeAgentTiming(detail);

	if (errors.length > 0) detail.error = errors.join("; ");
	return detail;
}

async function fetchTaskEvents(taskId: string, timeoutMs = 250): Promise<TaskEvent[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${kanadeBaseUrl()}/tasks/${encodeURIComponent(taskId)}/events`, {
			signal: controller.signal,
			headers: { Accept: "text/event-stream" },
		});
		if (!res.ok || !res.body) return [];
		return await collectSSEEvents(res.body, timer);
	} catch {
		return [];
	} finally {
		clearTimeout(timer);
	}
}

async function collectSSEEvents(
	body: ReadableStream<Uint8Array>,
	timer: ReturnType<typeof setTimeout>,
): Promise<TaskEvent[]> {
	const events: TaskEvent[] = [];
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let currentData = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (line.startsWith("data:")) {
					currentData = line.slice(5).trim();
					continue;
				}
				if (line.startsWith(":") || line.startsWith("event:") || line.startsWith("id:")) continue;
				if (line.trim() === "" && currentData) {
					pushParsedEvent(events, currentData);
					currentData = "";
				}
			}
		}
		if (currentData) pushParsedEvent(events, currentData);
	} catch {
		// Stream may abort; return whatever we collected
	} finally {
		reader.releaseLock();
		clearTimeout(timer);
	}
	return events;
}

function pushParsedEvent(events: TaskEvent[], rawData: string): void {
	try {
		const parsed = JSON.parse(rawData) as ServerEvent;
		if (TASK_EVENT_TYPES.includes(parsed.type)) {
			events.push({
				time: formatTime(parsed.ts),
				type: parsed.type,
				ts: parsed.ts,
				summary: summarizeTaskEvent(parsed.type, parsed.data),
			});
		}
	} catch {
		// skip malformed event
	}
}

function summarizeTaskEvent(type: string, data: unknown): string {
	const d = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
	switch (type) {
		case "task.created":
			return sanitizeText(`created${d.workflowPath ? ` · ${d.workflowPath}` : ""}`);
		case "task.running":
			return "started";
		case "task.finished":
			return "finished";
		case "task.failed":
			return sanitizeText(`failed${d.error ? ` · ${String(d.error).slice(0, 80)}` : ""}`);
		case "task.aborted":
			return "aborted";
		case "task.needs_human":
			return sanitizeText(
				`needs human${d.request ? ` · ${String((d.request as Record<string, unknown>)?.title ?? "").slice(0, 60)}` : ""}`,
			);
		case "task.human_resolved":
			return "human resolved";
		case "task.merged":
			return sanitizeText(`merged${d.mergeCommit ? ` · ${d.mergeCommit}` : ""}`);
		case "task.rejected":
			return "rejected";
		case "task.script_generated":
			return "script generated";
		case "workflow.phase":
			return sanitizeText(`phase: ${d.phase ?? ""}`);
		case "workflow.agent_started":
			return sanitizeText(`agent started${d.label ? ` · ${d.label}` : ""}`);
		case "workflow.agent_completed":
			return sanitizeText(`agent done${d.label ? ` · ${d.label}` : ""}${d.status ? ` · ${d.status}` : ""}`);
		case "workflow.log":
			return sanitizeText(truncatePlain(String(d.message ?? ""), 100));
		default:
			return type;
	}
}

function computeAgentTiming(detail: TaskDetail): AgentTiming {
	const task = detail.task;
	const sessionEvents = detail.sessionEvents ?? [];
	const taskEvents = detail.taskEvents ?? [];
	const startedAt = task?.started_at ?? task?.created_at;
	const elapsedMs =
		task?.finished_at && startedAt ? task.finished_at - startedAt : startedAt ? Date.now() - startedAt : undefined;
	const lastActivityTs = findLastActivityTs(sessionEvents, taskEvents);
	const lastActivityAt = lastActivityTs ?? startedAt;
	const idleMs = lastActivityAt ? Date.now() - lastActivityAt : undefined;
	return { startedAt, elapsedMs, lastActivityAt, idleMs };
}

function findLastActivityTs(sessionEvents: SessionEvent[], taskEvents: TaskEvent[]): number | undefined {
	let latest = 0;
	for (const ev of taskEvents) {
		if (ev.ts > latest) latest = ev.ts;
	}
	for (const ev of sessionEvents) {
		if (ev.rawTs && ev.rawTs > latest) latest = ev.rawTs;
	}
	return latest > 0 ? latest : undefined;
}

function parseWorkflowPlan(script: string): WorkflowPlanStep[] {
	const steps: WorkflowPlanStep[] = [];
	let phase = "Workflow";
	let conditionalDepth = 0;
	for (const rawLine of script.split("\n")) {
		const line = rawLine.trim();
		const phaseMatch = line.match(/\bphase\(\s*['"`]([^'"`]+)['"`]\s*\)/);
		if (phaseMatch?.[1]) {
			phase = phaseMatch[1];
			conditionalDepth = line.includes("if ") || line.startsWith("if(") ? 1 : conditionalDepth;
			continue;
		}
		if (/^if\b|^if\s*\(/.test(line)) conditionalDepth++;
		const helperMatch = line.match(
			/\b(implement|reviewChange|continueImplementation|testChange|requestHuman|askHuman)\s*\(/,
		);
		if (helperMatch?.[1]) {
			steps.push({
				phase,
				helper: helperMatch[1],
				label: workflowHelperLabel(helperMatch[1]),
				conditional: conditionalDepth > 0,
			});
		}
		if (line.includes("}") && conditionalDepth > 0) conditionalDepth--;
	}
	return steps;
}

function workflowHelperLabel(helper: string): string {
	if (helper === "implement") return "implement";
	if (helper === "reviewChange") return "review";
	if (helper === "continueImplementation") return "fix";
	if (helper === "testChange") return "validate";
	if (helper === "requestHuman" || helper === "askHuman") return "human gate";
	return helper;
}

function pickSession(sessions: SessionListItem[]): SessionListItem | undefined {
	return [...sessions].sort((a, b) => {
		const aLatest = a.files.at(-1) ?? "";
		const bLatest = b.files.at(-1) ?? "";
		return bLatest.localeCompare(aLatest);
	})[0];
}

function summarizeSessionEntries(entries: SessionEntry[]): SessionEvent[] {
	const events: SessionEvent[] = [];
	for (const entry of entries) {
		const time = formatTime(entry.timestamp);
		const rawTs = typeof entry.timestamp === "number" ? entry.timestamp : undefined;
		if (entry.type === "model_change") {
			events.push({
				time,
				rawTs,
				label: "model",
				summary: `${entry.provider ?? "provider"}/${entry.modelId ?? "model"}`,
			});
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!message?.content) continue;
		for (const part of message.content) {
			const type = String(part.type ?? "");
			if (type === "thinking") {
				events.push({ time, rawTs, label: "think", summary: firstLine(String(part.thinking ?? "thinking"), 180) });
			} else if (type === "text") {
				const text = firstLine(String(part.text ?? ""), 180);
				if (text) events.push({ time, rawTs, label: message.role === "user" ? "user" : "text", summary: text });
			} else if (type === "toolCall") {
				const name = String(part.name ?? "tool");
				events.push({ time, rawTs, label: toolLabel(name), summary: summarizeToolCall(name, part), state: "running" });
			} else if (type === "toolResult") {
				const name = String(part.toolName ?? "tool");
				events.push({
					time,
					rawTs,
					label: toolLabel(name),
					summary: summarizeToolResult(name, part),
					state: part.isError ? "error" : "done",
				});
			} else if (type === "structured_output") {
				events.push({ time, rawTs, label: "out", summary: "structured output" });
			}
		}
	}
	return compactToolPairs(events);
}

function toolLabel(name: string): string {
	if (name === "bash") return "bash";
	if (name === "read") return "read";
	if (name === "edit" || name === "write") return "edit";
	if (name === "grep" || name === "find" || name === "ls") return "find";
	return truncatePlain(name, 10);
}

function summarizeToolCall(name: string, part: Record<string, unknown>): string {
	const args =
		typeof part.arguments === "object" && part.arguments !== null ? (part.arguments as Record<string, unknown>) : {};
	const path = typeof args.path === "string" ? args.path : undefined;
	const command = typeof args.command === "string" ? args.command : undefined;
	const query = typeof args.query === "string" ? args.query : undefined;
	return truncatePlain(path ?? command ?? query ?? name, 180);
}

function summarizeToolResult(name: string, part: Record<string, unknown>): string {
	const content = Array.isArray(part.content) ? part.content : [];
	const text = content
		.map((item) => (typeof item === "object" && item !== null && "text" in item ? String(item.text) : ""))
		.filter(Boolean)
		.join(" ");
	if (!text) return `${name} complete`;
	if (/\b(\d+) lines?\b/i.test(text)) return RegExp.lastMatch;
	if (/\b(\d+) matches?\b/i.test(text)) return RegExp.lastMatch;
	return firstLine(text, 180);
}

function compactToolPairs(events: SessionEvent[]): SessionEvent[] {
	const compact: SessionEvent[] = [];
	for (const event of events) {
		const previous = compact.at(-1);
		if (
			previous &&
			previous.label === event.label &&
			previous.summary === event.summary &&
			previous.state === "running"
		) {
			previous.state = event.state ?? "done";
			continue;
		}
		compact.push(event);
	}
	return compact;
}

class ActionMenuOverlay implements Component {
	private selected = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly theme: Theme,
		private readonly taskId: string,
		private readonly items: ActionItem[],
		private readonly done: (value: ActionItem | null) => void,
	) {}

	invalidate(): void {
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const body = [this.theme.fg("muted", `Actions · ${this.taskId}`), ""];
		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i];
			const prefix = i === this.selected ? this.theme.fg("accent", "▸") : " ";
			const label = item.danger ? this.theme.fg("warning", item.label) : item.label;
			body.push(`${prefix} ${label}`);
		}
		body.push("");
		body.push(this.theme.fg("dim", "↑↓ select · Enter run · Esc cancel"));
		this.cachedWidth = width;
		this.cachedLines = box(body, Math.min(width, 58), "Kanade Actions", this.theme);
		return this.cachedLines;
	}

	handleInput(data: string): void {
		this.cachedLines = undefined;
		if (isKey(data, "escape", "\x1b") || isKey(data, "ctrl+c") || data === "q" || data === "Q") {
			this.done(null);
			return;
		}
		if (isKey(data, "up", "\x1b[A", "\x1bOA")) {
			this.selected = Math.max(0, this.selected - 1);
			return;
		}
		if (isKey(data, "down", "\x1b[B", "\x1bOB")) {
			this.selected = Math.min(Math.max(0, this.items.length - 1), this.selected + 1);
			return;
		}
		if (isKey(data, "return", "\r", "\n") || isKey(data, "enter", "\r", "\n")) {
			this.done(this.items[this.selected] ?? null);
		}
	}
}

class ConfirmOverlay implements Component {
	constructor(
		private readonly theme: Theme,
		private readonly dialog: ConfirmDialog,
		private readonly done: (value: boolean) => void,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const body = [this.theme.fg(this.dialog.danger ? "warning" : "muted", this.dialog.title), ""];
		const contentWidth = Math.max(40, width - 4);
		for (const line of wrapPlain(this.dialog.message, contentWidth).slice(0, 7)) {
			body.push(this.theme.fg("dim", line));
		}
		body.push("");
		body.push(
			`${this.theme.fg(this.dialog.danger ? "error" : "warning", `Enter / y: ${this.dialog.confirmLabel}`)}    ${this.theme.fg("dim", "Esc / n: cancel")}`,
		);
		return box(body, width, "Confirm", this.theme);
	}

	handleInput(data: string): void {
		if (isKey(data, "escape", "\x1b") || isKey(data, "ctrl+c") || data === "n" || data === "N" || data === "q") {
			this.done(false);
			return;
		}
		if (data === "y" || data === "Y" || isKey(data, "return", "\r", "\n") || isKey(data, "enter", "\r", "\n")) {
			this.done(true);
		}
	}
}

class SettingsOverlay implements Component {
	private selected = 0;
	private saving = false;
	private notice?: { kind: "info" | "warning" | "error"; text: string };
	private savedField?: string;
	private editBuffer?: string;
	private editCursor = 0;
	private pendingConfirm?: { message: string; field: SettingsFieldDef; value: unknown };
	private searchMode = false;
	private searchQuery = "";
	private rawMode: "selected" | "all" | undefined;
	private readonly expandedGroups = new Set<number>();

	constructor(
		private readonly tui: TuiHandle,
		private readonly theme: Theme,
		private readonly config: Record<string, unknown>,
		private readonly done: () => void,
	) {
		this.expandedGroups.add(0);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const boxWidth = Math.min(Math.max(72, width), 120);
		const contentWidth = Math.max(40, boxWidth - 4);
		const lines: string[] = [this.theme.fg("muted", "Global Kanade Settings"), ""];
		if (this.rawMode) return this.renderRawConfig(boxWidth, contentWidth, lines, this.rawMode);
		const displayItems = this.displayItems();
		lines.push(
			this.theme.fg(
				"dim",
				`Config: ${String((this.config.paths as Record<string, unknown>)?.configFile ?? "unknown")}`,
			),
		);
		if (this.searchMode || this.searchQuery) {
			const cursor = this.searchMode ? "▏" : "";
			lines.push(this.theme.fg("accent", `Search: ${this.searchQuery}${cursor}`));
		}
		lines.push(rule(Math.min(60, contentWidth), this.theme));

		const listRows = this.editBuffer !== undefined || this.pendingConfirm ? 10 : 16;
		const windowed = windowAroundSelection(displayItems, this.selected, listRows);
		if (windowed.start > 0) lines.push(this.theme.fg("dim", `  ... ${windowed.start} above`));
		for (let offset = 0; offset < windowed.items.length; offset++) {
			const i = windowed.start + offset;
			const item = windowed.items[offset];
			if (!item) continue;
			if (item.kind === "section") {
				const selected = i === this.selected && !this.editBuffer && !this.pendingConfirm;
				const prefix = selected ? this.theme.fg("accent", "▸") : " ";
				const marker = item.expanded ? "[-]" : "[+]";
				lines.push(
					`${prefix} ${this.theme.fg(item.expanded ? "muted" : "dim", `${marker} ${item.label}`)} ${this.theme.fg("dim", `(${item.fieldCount})`)}`,
				);
				continue;
			}
			const field = item.field;
			const value = this.getFieldValue(field.key);
			const selected = i === this.selected && !this.editBuffer && !this.pendingConfirm;
			const prefix = selected ? this.theme.fg("accent", "▸") : " ";
			const display = this.displayValue(field, value);
			const dangerTag = field.dangerous ? this.theme.fg("warning", " ⚠") : "";
			const restart = settingRequiresRestart(field.key);
			const lifecycleTag = this.theme.fg(restart ? "warning" : "dim", ` [${restart ? "restart" : "live"}]`);
			if (field.readOnly) {
				lines.push(
					`${prefix} ${this.theme.fg("dim", `${field.label}: ${display}`)}${this.theme.fg("dim", " [read-only]")}${lifecycleTag}`,
				);
			} else {
				lines.push(`${prefix} ${this.theme.fg("dim", field.label)}: ${display}${dangerTag}${lifecycleTag}`);
			}
		}
		if (windowed.end < displayItems.length)
			lines.push(this.theme.fg("dim", `  ... ${displayItems.length - windowed.end} below`));

		if (this.pendingConfirm) {
			lines.push("");
			lines.push(this.theme.fg("warning", "Confirm Change"));
			for (const line of wrapPlain(this.pendingConfirm.message, contentWidth).slice(0, 3)) {
				lines.push(this.theme.fg("dim", line));
			}
			lines.push(this.theme.fg("dim", "Enter / y confirm · Esc / n cancel"));
		}

		// Edit mode indicator
		if (this.editBuffer !== undefined) {
			lines.push("");
			const field = this.currentField();
			if (field) {
				if (field.type === "json" || field.type === "record") {
					lines.push(this.theme.fg("accent", `Editing ${field.label}:`));
					const bufLines = renderBufferWithCursor(this.editBuffer, this.editCursor);
					for (const bl of bufLines) {
						lines.push(this.theme.fg("accent", `  ${bl}`));
					}
				} else {
					const rendered = renderBufferWithCursor(this.editBuffer, this.editCursor)[0] ?? "▏";
					lines.push(this.theme.fg("accent", `Editing ${field.label}: ${rendered}`));
				}
				if (field.type === "record") {
					lines.push(this.theme.fg("dim", "One role=model per line · arrows move · Ctrl+S save · Esc cancel"));
				} else if (field.type === "json") {
					lines.push(this.theme.fg("dim", "Arrows move · Enter newline · Ctrl+S save · Esc cancel"));
				} else {
					lines.push(this.theme.fg("dim", "Arrows move · Enter save · Esc cancel"));
				}
			}
		}

		// Notice
		if (this.notice) {
			lines.push("");
			const color = this.notice.kind === "info" ? "success" : this.notice.kind;
			lines.push(this.theme.fg(color, this.notice.text));
		}

		// Saved flash
		if (this.savedField && !this.notice) {
			lines.push("");
			lines.push(this.theme.fg("success", `✓ Saved ${this.savedField}`));
		}

		lines.push("");
		if (!this.editBuffer) {
			lines.push(
				this.theme.fg(
					"dim",
					"↑↓ select · Enter expand/edit/toggle · / search · r raw selected · R raw all · Esc close",
				),
			);
		}

		const fitLines = fitBodyRows(lines, 18, 28);
		return box(fitLines, boxWidth, "Kanade Settings", this.theme);
	}

	private renderRawConfig(boxWidth: number, contentWidth: number, lines: string[], mode: "selected" | "all"): string[] {
		const target = mode === "all" ? this.rawAllTarget() : this.rawSelectedTarget();
		lines.push(this.theme.fg("dim", `Raw · ${target.label} (read-only)`));
		lines.push(rule(Math.min(60, contentWidth), this.theme));
		const raw = JSON.stringify(target.value, null, 2).split("\n");
		for (const line of raw.slice(0, 18)) lines.push(this.theme.fg("dim", truncatePlain(line, contentWidth)));
		if (raw.length > 18) lines.push(this.theme.fg("dim", `... ${raw.length - 18} more lines`));
		lines.push("");
		lines.push(this.theme.fg("dim", "r back to fields · Esc close"));
		return box(fitBodyRows(lines, 18, 28), boxWidth, "Kanade Settings", this.theme);
	}

	private rawAllTarget(): { label: string; value: unknown } {
		return { label: "config", value: this.config };
	}

	private rawSelectedTarget(): { label: string; value: unknown } {
		const item = this.currentItem();
		if (item?.kind === "field") return { label: item.field.key, value: this.getFieldValue(item.field.key) };
		if (item?.kind === "section") {
			const group = SETTINGS_GROUPS[item.groupIndex];
			if (group?.section && !group.section.startsWith("_"))
				return { label: group.section, value: this.getFieldValue(group.section) };
			if (group) {
				const value: Record<string, unknown> = {};
				for (const field of group.fields) value[field.key] = this.getFieldValue(field.key);
				return { label: group.label, value };
			}
		}
		return this.rawAllTarget();
	}

	private displayItems(): SettingsDisplayItem[] {
		const items: SettingsDisplayItem[] = [];
		const query = this.searchQuery.trim().toLowerCase();
		if (query) {
			for (let groupIndex = 0; groupIndex < SETTINGS_GROUPS.length; groupIndex++) {
				const group = SETTINGS_GROUPS[groupIndex]!;
				for (const field of group.fields) {
					const haystack = `${field.label} ${field.key} ${field.section} ${group.label}`.toLowerCase();
					if (haystack.includes(query)) items.push({ kind: "field", groupIndex, field });
				}
			}
			this.selected = Math.min(this.selected, Math.max(0, items.length - 1));
			return items;
		}
		for (let groupIndex = 0; groupIndex < SETTINGS_GROUPS.length; groupIndex++) {
			const group = SETTINGS_GROUPS[groupIndex]!;
			const expanded = this.expandedGroups.has(groupIndex);
			items.push({ kind: "section", groupIndex, label: group.label, expanded, fieldCount: group.fields.length });
			if (expanded) {
				for (const field of group.fields) items.push({ kind: "field", groupIndex, field });
			}
		}
		this.selected = Math.min(this.selected, Math.max(0, items.length - 1));
		return items;
	}

	private currentItem(): SettingsDisplayItem | undefined {
		return this.displayItems()[this.selected];
	}

	private currentField(): SettingsFieldDef | undefined {
		const item = this.currentItem();
		return item?.kind === "field" ? item.field : undefined;
	}

	handleInput(data: string): void {
		if (this.rawMode) {
			if (data === "r" || data === "R") {
				this.rawMode = undefined;
				this.tui.requestRender();
				return;
			}
			if (isKey(data, "escape", "\x1b") || isKey(data, "ctrl+c") || data === "q" || data === "Q") {
				this.done();
				return;
			}
			return;
		}

		if (this.pendingConfirm) {
			if (
				isKey(data, "escape", "\x1b") ||
				isKey(data, "ctrl+c") ||
				data === "n" ||
				data === "N" ||
				data === "q" ||
				data === "Q"
			) {
				this.pendingConfirm = undefined;
				this.notice = { kind: "warning", text: "Cancelled." };
				this.tui.requestRender();
				return;
			}
			if (data === "y" || data === "Y" || isKey(data, "return", "\r", "\n") || isKey(data, "enter", "\r", "\n")) {
				const { field, value } = this.pendingConfirm;
				this.pendingConfirm = undefined;
				void this.patchField(field.key, value);
				return;
			}
			return;
		}

		// Edit mode
		if (this.editBuffer !== undefined) {
			const field = this.currentField();
			if (field) {
				handleEditModeInput(
					data,
					this.editBuffer,
					this.editCursor,
					field,
					(buffer, cursor) => {
						this.editBuffer = buffer;
						this.editCursor = cursor;
					},
					() => {
						this.editBuffer = undefined;
						this.editCursor = 0;
					},
					() => void this.saveCurrentField(),
				);
			}
			return;
		}

		if (this.searchMode) {
			if (isKey(data, "escape", "\x1b") || isKey(data, "ctrl+c")) {
				this.searchMode = false;
				this.searchQuery = "";
				this.selected = 0;
				this.tui.requestRender();
				return;
			}
			if (isKey(data, "up", "\x1b[A", "\x1bOA")) {
				this.selected = Math.max(0, this.selected - 1);
				this.tui.requestRender();
				return;
			}
			if (isKey(data, "down", "\x1b[B", "\x1bOB")) {
				this.selected = Math.min(this.displayItems().length - 1, this.selected + 1);
				this.tui.requestRender();
				return;
			}
			if (isKey(data, "return", "\r", "\n") || isKey(data, "enter", "\r", "\n")) {
				this.searchMode = false;
				void this.activateField();
				this.tui.requestRender();
				return;
			}
			if (isKey(data, "backspace")) {
				this.searchQuery = this.searchQuery.slice(0, -1);
				this.selected = 0;
				this.tui.requestRender();
				return;
			}
			if (data.length === 1 && data >= " " && data <= "~") {
				this.searchQuery += data;
				this.selected = 0;
				this.tui.requestRender();
				return;
			}
			return;
		}

		if (isKey(data, "escape", "\x1b") || isKey(data, "ctrl+c") || data === "q" || data === "Q") {
			if (this.searchQuery) {
				this.searchQuery = "";
				this.selected = 0;
				this.tui.requestRender();
				return;
			}
			this.done();
			return;
		}
		if (isKey(data, "up", "\x1b[A", "\x1bOA")) {
			this.selected = Math.max(0, this.selected - 1);
			this.notice = undefined;
			this.savedField = undefined;
			return;
		}
		if (isKey(data, "down", "\x1b[B", "\x1bOB")) {
			this.selected = Math.min(this.displayItems().length - 1, this.selected + 1);
			this.notice = undefined;
			this.savedField = undefined;
			return;
		}
		if (data === "/") {
			this.searchMode = true;
			this.notice = undefined;
			this.savedField = undefined;
			this.tui.requestRender();
			return;
		}
		if (data === "r" || data === "R") {
			this.rawMode = data === "R" ? "all" : "selected";
			this.notice = undefined;
			this.savedField = undefined;
			this.tui.requestRender();
			return;
		}
		if (isKey(data, "return", "\r", "\n") || isKey(data, "enter", "\r", "\n")) {
			void this.activateField();
		}
	}

	private getFieldValue(key: string): unknown {
		const parts = key.split(".");
		let current: unknown = this.config;
		for (const part of parts) {
			if (typeof current !== "object" || current === null) return undefined;
			current = (current as Record<string, unknown>)[part];
		}
		return current;
	}

	private displayValue(field: SettingsFieldDef, value: unknown): string {
		if (field.type === "boolean") return value ? "true" : "false";
		if (field.type === "record") return displayRecordValue(value);
		if (field.type === "json") {
			if (value && typeof value === "object") return JSON.stringify(value);
			return String(value ?? "{}");
		}
		return String(value ?? "");
	}

	private async activateField(): Promise<void> {
		const item = this.currentItem();
		if (item?.kind === "section") {
			if (this.expandedGroups.has(item.groupIndex)) this.expandedGroups.delete(item.groupIndex);
			else this.expandedGroups.add(item.groupIndex);
			this.notice = undefined;
			this.savedField = undefined;
			this.tui.requestRender();
			return;
		}
		const field = item?.field;
		if (!field) return;
		if (field.readOnly) {
			this.notice = { kind: "warning", text: `${field.label} is read-only.` };
			return;
		}
		if (field.type === "boolean") {
			await this.toggleBoolean(field);
		} else {
			// Enter edit mode for string/number/json
			const current = this.getFieldValue(field.key);
			if (field.type === "record") {
				this.editBuffer = formatRecordEditorValue(current);
			} else if (field.type === "json") {
				this.editBuffer = current && typeof current === "object" ? JSON.stringify(current, null, 2) : "{}";
			} else {
				this.editBuffer = String(current ?? "");
			}
			this.editCursor = this.editBuffer.length;
			this.notice = undefined;
			this.savedField = undefined;
		}
	}

	private async toggleBoolean(field: SettingsFieldDef): Promise<void> {
		const current = this.getFieldValue(field.key);
		const next = !current;

		if (field.dangerous) {
			this.pendingConfirm = {
				field,
				value: next,
				message: `${field.label}: ${current ? "true" : "false"} -> ${next ? "true" : "false"}. Confirm change?`,
			};
			this.tui.requestRender();
			return;
		}

		await this.patchField(field.key, next);
	}

	private async saveCurrentField(): Promise<void> {
		const field = this.currentField();
		if (!field) return;
		const buffer = this.editBuffer ?? "";
		let value: unknown;

		if (field.type === "number") {
			const parsed = Number(buffer);
			if (Number.isNaN(parsed)) {
				this.notice = { kind: "error", text: "Invalid number." };
				this.editBuffer = undefined;
				return;
			}
			value = parsed;
		} else if (field.type === "record") {
			try {
				value = parseRecordEditorValue(buffer);
			} catch (error) {
				this.notice = { kind: "error", text: error instanceof Error ? error.message : String(error) };
				return;
			}
		} else if (field.type === "json") {
			try {
				value = JSON.parse(buffer);
			} catch {
				this.notice = { kind: "error", text: "Invalid JSON." };
				return;
			}
		} else {
			value = buffer;
		}

		this.editBuffer = undefined;
		this.editCursor = 0;

		if (field.dangerous) {
			this.pendingConfirm = { field, value, message: `Set ${field.label} to ${JSON.stringify(value)}. Confirm?` };
			this.tui.requestRender();
			return;
		}

		await this.patchField(field.key, value);
	}

	private async patchField(key: string, value: unknown): Promise<void> {
		if (this.saving) return;
		this.saving = true;
		this.notice = undefined;
		this.savedField = undefined;
		this.tui.requestRender();
		try {
			await patchJson("/config", buildConfigPatch(key, value));
			this.notice = { kind: "info", text: `✓ Saved ${key}` };
			this.savedField = key;
			// Update local config cache
			this.setFieldValue(key, value);
		} catch (error) {
			this.notice = { kind: "error", text: error instanceof Error ? error.message : String(error) };
		} finally {
			this.saving = false;
			this.tui.requestRender();
		}
	}

	private setFieldValue(key: string, value: unknown): void {
		const parts = key.split(".");
		let current: Record<string, unknown> = this.config;
		for (let i = 0; i < parts.length - 1; i++) {
			const part = parts[i];
			const next = current[part];
			if (typeof next !== "object" || next === null) {
				current[part] = {};
			}
			current = current[part] as Record<string, unknown>;
		}
		current[parts[parts.length - 1]!] = value;
	}
}

function settingRequiresRestart(key: string): boolean {
	return (
		key === "server.port" ||
		key === "server.bind" ||
		key.startsWith("paths.") ||
		key === "models.authPath" ||
		key === "models.modelsPath" ||
		key === "models.agentDir" ||
		key === "models.piAgentDir"
	);
}

function buildConfigPatch(key: string, value: unknown): Record<string, unknown> {
	const parts = key.split(".");
	if (parts.length < 2) return { [key]: value };
	const root: Record<string, unknown> = {};
	let current = root;
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i]!;
		const next: Record<string, unknown> = {};
		current[part] = next;
		current = next;
	}
	current[parts[parts.length - 1]!] = value;
	return root;
}

function displayRecordValue(value: unknown): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "";
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length === 0) return "";
	return entries.map(([key, item]) => `${key}=${String(item ?? "")}`).join(", ");
}

function formatRecordEditorValue(value: unknown): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "";
	return Object.entries(value as Record<string, unknown>)
		.map(([key, item]) => `${key}=${String(item ?? "")}`)
		.join("\n");
}

function parseRecordEditorValue(buffer: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const rawLine of buffer.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		const sep = line.indexOf("=");
		if (sep <= 0) throw new Error("Invalid role model line. Use role=model.");
		const key = line.slice(0, sep).trim();
		const value = line.slice(sep + 1).trim();
		if (!key) throw new Error("Role name is required.");
		result[key] = value;
	}
	return result;
}

function handleEditModeInput(
	data: string,
	buffer: string,
	cursor: number,
	field: SettingsFieldDef,
	setBuffer: (b: string, cursor: number) => void,
	cancel: () => void,
	save: () => void,
): void {
	const safeCursor = clampCursor(buffer, cursor);
	if (isKey(data, "escape", "\x1b") || isKey(data, "ctrl+c")) {
		cancel();
		return;
	}
	// Ctrl+S saves (works for all field types including JSON)
	if (isKey(data, "ctrl+s") || data === "\x13") {
		save();
		return;
	}
	// For multi-line fields, Enter inserts a newline; use Ctrl+S to save
	if (
		((field.type === "json" || field.type === "record") && isKey(data, "return", "\r", "\n")) ||
		isKey(data, "enter", "\r", "\n")
	) {
		if (field.type === "json" || field.type === "record") {
			setBuffer(`${buffer.slice(0, safeCursor)}\n${buffer.slice(safeCursor)}`, safeCursor + 1);
			return;
		}
	}
	// For single-line fields, Enter saves
	if (
		field.type !== "json" &&
		field.type !== "record" &&
		(isKey(data, "return", "\r", "\n") || isKey(data, "enter", "\r", "\n"))
	) {
		save();
		return;
	}
	if (isKey(data, "left", "\x1b[D", "\x1bOD")) {
		setBuffer(buffer, Math.max(0, safeCursor - 1));
		return;
	}
	if (isKey(data, "right", "\x1b[C", "\x1bOC")) {
		setBuffer(buffer, Math.min(buffer.length, safeCursor + 1));
		return;
	}
	if (isKey(data, "up", "\x1b[A", "\x1bOA")) {
		setBuffer(buffer, moveCursorVertically(buffer, safeCursor, -1));
		return;
	}
	if (isKey(data, "down", "\x1b[B", "\x1bOB")) {
		setBuffer(buffer, moveCursorVertically(buffer, safeCursor, 1));
		return;
	}
	if (data === "\x1b[H" || data === "\x1b[1~") {
		setBuffer(buffer, lineStartOffset(buffer, safeCursor));
		return;
	}
	if (data === "\x1b[F" || data === "\x1b[4~") {
		setBuffer(buffer, lineEndOffset(buffer, safeCursor));
		return;
	}
	if (isKey(data, "backspace")) {
		if (safeCursor > 0) setBuffer(buffer.slice(0, safeCursor - 1) + buffer.slice(safeCursor), safeCursor - 1);
		return;
	}
	if (field.type === "number") {
		if (data === "+") {
			const n = Number(buffer);
			const next = String(Number.isNaN(n) ? 1 : n + 1);
			setBuffer(next, next.length);
			return;
		}
		if (data === "-") {
			const n = Number(buffer);
			const next = String(Number.isNaN(n) ? 0 : n - 1);
			setBuffer(next, next.length);
			return;
		}
	}
	// Allow typing printable characters
	if (data.length === 1 && data >= " " && data <= "~") {
		setBuffer(buffer.slice(0, safeCursor) + data + buffer.slice(safeCursor), safeCursor + data.length);
	}
}

function renderBufferWithCursor(buffer: string, cursor: number): string[] {
	const safeCursor = clampCursor(buffer, cursor);
	const rendered = `${buffer.slice(0, safeCursor)}▏${buffer.slice(safeCursor)}`;
	return rendered.split("\n");
}

function clampCursor(buffer: string, cursor: number): number {
	return Math.max(0, Math.min(buffer.length, cursor));
}

function lineStartOffset(buffer: string, cursor: number): number {
	const safeCursor = clampCursor(buffer, cursor);
	const previousBreak = buffer.lastIndexOf("\n", Math.max(0, safeCursor - 1));
	return previousBreak < 0 ? 0 : previousBreak + 1;
}

function lineEndOffset(buffer: string, cursor: number): number {
	const safeCursor = clampCursor(buffer, cursor);
	const nextBreak = buffer.indexOf("\n", safeCursor);
	return nextBreak < 0 ? buffer.length : nextBreak;
}

function moveCursorVertically(buffer: string, cursor: number, direction: -1 | 1): number {
	const safeCursor = clampCursor(buffer, cursor);
	const lineStart = lineStartOffset(buffer, safeCursor);
	const column = safeCursor - lineStart;
	if (direction < 0) {
		if (lineStart === 0) return safeCursor;
		const previousLineEnd = lineStart - 1;
		const previousLineStart = lineStartOffset(buffer, previousLineEnd);
		return Math.min(previousLineStart + column, previousLineEnd);
	}
	const lineEnd = lineEndOffset(buffer, safeCursor);
	if (lineEnd >= buffer.length) return safeCursor;
	const nextLineStart = lineEnd + 1;
	const nextLineEnd = lineEndOffset(buffer, nextLineStart);
	return Math.min(nextLineStart + column, nextLineEnd);
}

class AgentDetailOverlay implements Component {
	private detail?: TaskDetail;
	private error?: string;
	private loading = true;
	private disposed = false;
	private inFlight = false;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly tui: TuiHandle,
		private readonly theme: Theme,
		private readonly task: KanadeTask,
		private readonly done: () => void,
		initialDetail?: TaskDetail,
		initialError?: string,
	) {
		this.detail = initialDetail;
		this.error = initialError;
		this.loading = !initialDetail && !initialError;
		if (!initialError) void this.refresh(false);
	}

	invalidate(): void {
		this.cachedLines = undefined;
	}

	dispose(): void {
		this.disposed = true;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const contentWidth = Math.max(72, width - 4);
		const body: string[] = [];
		body.push(`${this.task.id} · ${taskTitle(this.task, 32)}${padToRight(this.task.status, 8)}`);
		body.push(rule(contentWidth, this.theme));
		if (this.loading) body.push(this.theme.fg("dim", "loading agent detail..."));
		if (this.error) body.push(this.theme.fg("warning", truncatePlain(this.error, contentWidth)));
		const agents = this.detail?.snapshot?.agents ?? [];
		const activeAgent = agents.find((agent) => agent.status === "running") ?? agents.at(-1);
		if (activeAgent) {
			body.push(`${this.theme.fg("muted", "Agent:")} ${activeAgent.label} · ${activeAgent.status}`);
			const summary = activeAgent.error || activeAgent.resultPreview;
			if (summary) body.push(this.theme.fg("dim", agentSummaryLine(summary, contentWidth)));
		} else {
			body.push(this.theme.fg("dim", "No agent snapshot yet."));
		}
		// Timing fields
		const timing = this.detail?.timing;
		if (timing) {
			const parts: string[] = [];
			if (timing.startedAt) parts.push(`started ${relativeTime(timing.startedAt)}`);
			if (typeof timing.elapsedMs === "number") parts.push(`elapsed ${formatDuration(timing.elapsedMs)}`);
			if (timing.lastActivityAt) parts.push(`last activity ${relativeTime(timing.lastActivityAt)}`);
			if (typeof timing.idleMs === "number" && timing.idleMs > 5000)
				parts.push(`idle ${formatDuration(timing.idleMs)}`);
			if (parts.length > 0) body.push(this.theme.fg("dim", parts.join(" · ")));
		}
		const sessions = this.detail?.sessions ?? [];
		if (this.detail?.sessionLabel) body.push(this.theme.fg("dim", `Session: ${this.detail.sessionLabel}`));
		else if (sessions.length > 0)
			body.push(this.theme.fg("dim", `Sessions: ${sessions.map((s) => s.label).join(", ")}`));
		const model = latestSessionModel(this.detail?.sessionEvents ?? []);
		if (model) body.push(this.theme.fg("dim", `Model: ${model}`));
		body.push(rule(contentWidth, this.theme));
		body.push(this.theme.fg("muted", "Activity"));
		const events = this.detail?.sessionEvents ?? [];
		if (events.length === 0) body.push(this.theme.fg("dim", "No persisted session events yet."));
		for (const event of events.slice(-20)) {
			const state = event.state === "running" ? "active" : event.state === "error" ? "!" : "·";
			body.push(truncateAnsi(`${event.time} ${state} ${eventLabel(event)} ${event.summary}`, contentWidth));
			if (event.detail) body.push(this.theme.fg("dim", truncatePlain(`    ${event.detail}`, contentWidth)));
		}
		body.push(this.theme.fg("dim", "r refresh · Esc close"));
		this.cachedWidth = width;
		this.cachedLines = box(fitBodyRows(body, 27, 30), width, "Kanade Agent Detail", this.theme);
		return this.cachedLines;
	}

	handleInput(data: string): void {
		if (isKey(data, "escape", "\x1b") || isKey(data, "ctrl+c") || data === "q" || data === "Q") {
			this.dispose();
			this.done();
			return;
		}
		if (data === "r" || data === "R") void this.refresh(true);
	}

	private async refresh(showLoading: boolean): Promise<void> {
		if (this.disposed || this.inFlight) return;
		this.inFlight = true;
		if (showLoading) this.loading = true;
		this.error = undefined;
		this.invalidate();
		this.tui.requestRender();
		try {
			this.detail = await fetchTaskDetail(this.task.id, true);
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.inFlight = false;
			this.loading = false;
			if (!this.disposed) {
				this.invalidate();
				this.tui.requestRender();
			}
		}
	}
}

function sortTasks(tasks: KanadeTask[]): KanadeTask[] {
	const priority = (task: KanadeTask): number => {
		switch (task.status) {
			case "needs_human":
				return 0;
			case "running":
			case "created":
				return 1;
			default:
				return 2;
		}
	};
	return [...tasks].sort((a, b) => priority(a) - priority(b) || Number(b.created_at ?? 0) - Number(a.created_at ?? 0));
}

class KanadePanel implements Component {
	private overview: KanadeOverview = { connected: false, baseUrl: kanadeBaseUrl(), tasks: [], inbox: [] };
	private selected = 0;
	private searchQuery = "";
	private searchMode = false;
	private taskLimit = MAX_VISIBLE_TASKS;
	private loading = true;
	private activeTab: Tab = "Map";
	private details = new Map<string, TaskDetail>();
	private cachedWidth?: number;
	private cachedLines?: string[];
	private closed = false;
	private actionInProgress = false;
	private activeOperation?: ActiveOperation;
	private operationTimer: ReturnType<typeof setInterval> | undefined;
	private detailLoadSeq = 0;
	private detailLoadTimer: ReturnType<typeof setTimeout> | undefined;
	private actionMenu?: { taskId: string; items: ActionItem[]; selected: number };
	private confirmDialog?: ConfirmDialog;
	private lastNotice?: { kind: "info" | "warning" | "error"; text: string };

	constructor(
		private readonly tui: TuiHandle,
		private readonly theme: Theme,
		private readonly ui: Ui,
		private readonly done: () => void,
	) {}

	async refresh(): Promise<void> {
		this.tickSpinner();
		this.loading = true;
		this.invalidateAndRender();
		this.overview = await fetchTasksOverview(this.overview.inbox);
		this.selected = Math.min(this.selected, Math.max(0, this.filteredTasks().tasks.length - 1));
		this.loading = false;
		this.invalidateAndRender();
		this.scheduleSelectedDetailLoad(180);
		void this.refreshInbox();
	}

	private async refreshInbox(): Promise<void> {
		if (!this.overview.connected || this.closed) return;
		const inbox = await fetchInbox();
		if (this.closed) return;
		this.overview = { ...this.overview, inbox };
		this.invalidateAndRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const outerWidth = Math.max(64, width);
		const innerWidth = outerWidth - 4;
		const body: string[] = [];
		body.push(this.headerLine(innerWidth));
		body.push(rule(innerWidth, this.theme));

		if (this.loading) {
			body.push(`${this.color("dim", "Loading")} Kanade tasks...`);
		} else if (!this.overview.connected) {
			body.push(`${this.color("error", "× offline")} ${this.color("muted", this.overview.error ?? "unknown error")}`);
			body.push(this.color("dim", `URL: ${this.overview.baseUrl}`));
		} else {
			if (innerWidth >= 104) this.renderWide(body, innerWidth);
			else this.renderNarrow(body, innerWidth);
		}

		if (this.activeOperation) {
			body.push(rule(innerWidth, this.theme));
			body.push(this.activeOperationLine(innerWidth));
		} else if (this.lastNotice) {
			body.push(rule(innerWidth, this.theme));
			body.push(this.color(this.lastNotice.kind === "info" ? "muted" : this.lastNotice.kind, this.lastNotice.text));
		}
		body.push(this.helpLine(innerWidth));

		const lines = box(
			normalizeBodyRows(body, PANEL_BODY_ROWS, innerWidth, this.theme),
			outerWidth,
			"Kanade Cockpit",
			this.theme,
		);
		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (this.closed) return;
		this.tickSpinner();
		if (this.actionInProgress) return;
		if (this.confirmDialog) {
			this.handleConfirmInput(data);
			return;
		}
		if (this.actionMenu) {
			this.handleActionMenuInput(data);
			return;
		}
		if (this.searchMode && isKey(data, "escape", "\x1b")) {
			this.searchMode = false;
			this.invalidateAndRender();
			return;
		}
		if (!this.searchMode && isKey(data, "escape", "\x1b") && this.searchQuery.length > 0) {
			this.setSearchQuery("");
			return;
		}
		if (
			isKey(data, "escape", "\x1b") ||
			isKey(data, "ctrl+c") ||
			(!this.searchMode && (data === "q" || data === "Q"))
		) {
			this.close();
			return;
		}
		if (isKey(data, "up", "\x1b[A", "\x1bOA")) {
			this.selected = Math.max(0, this.selected - 1);
			this.invalidateAndRender();
			this.scheduleSelectedDetailLoad();
			return;
		}
		if (isKey(data, "down", "\x1b[B", "\x1bOB")) {
			this.selected = Math.min(Math.max(0, this.filteredTasks().tasks.length - 1), this.selected + 1);
			this.invalidateAndRender();
			this.scheduleSelectedDetailLoad();
			return;
		}
		if (isKey(data, "backspace") && this.searchQuery.length > 0) {
			this.setSearchQuery(this.searchQuery.slice(0, -1));
			return;
		}
		if (this.searchMode) {
			if (isKey(data, "backspace")) return;
			if (isKey(data, "return", "\r", "\n") || isKey(data, "enter", "\r", "\n")) {
				this.searchMode = false;
				this.invalidateAndRender();
				this.scheduleSelectedDetailLoad(0, this.activeTab === "Agent");
				if (this.searchQuery.trim().length > 0 && this.filteredTasks().tasks.length > 0) void this.openActions();
				return;
			}
			if (data.length === 1 && data >= " " && data <= "~") {
				this.setSearchQuery(this.searchQuery + data);
				return;
			}
		}
		if (isKey(data, "tab", "\t", "\x09")) {
			const i = TABS.indexOf(this.activeTab);
			this.activeTab = TABS[(i + 1) % TABS.length];
			this.invalidateAndRender();
			this.scheduleSelectedDetailLoad(0, this.activeTab === "Agent", this.activeTab === "Events");
			return;
		}
		if (isKey(data, "return", "\r", "\n") || isKey(data, "enter", "\r", "\n")) {
			void this.openActions();
			return;
		}
		if (data === "r" || data === "R") {
			void this.refresh();
			return;
		}
		if (data === "/") {
			this.searchMode = true;
			this.invalidateAndRender();
			return;
		}
		if (data === "f" || data === "F") {
			void this.openAgentDetail();
			return;
		}
		if (data === "s" || data === "S") {
			void this.openSettings();
			return;
		}
		if (data === "e" || data === "E") {
			const task = this.selectedTask();
			if (task?.status === "failed" || task?.status === "aborted") this.activeTab = "Worktree";
			else this.activeTab = this.activeTab === "Map" ? "Result" : "Map";
			this.invalidateAndRender();
			this.scheduleSelectedDetailLoad(0, false);
		}
	}

	private setSearchQuery(value: string): void {
		this.searchQuery = value;
		this.selected = 0;
		this.invalidateAndRender();
		this.scheduleSelectedDetailLoad();
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.detailLoadTimer) clearTimeout(this.detailLoadTimer);
		this.stopOperation();
		this.done();
	}

	private async openActions(): Promise<void> {
		const task = this.selectedTask();
		if (!task) return;
		this.lastNotice = undefined;
		const items = this.actionItems(task);
		this.actionInProgress = true;
		this.invalidateAndRender();
		try {
			const selected = await this.ui.custom<ActionItem | null>(
				(_tui, theme, _keybindings, done) => new ActionMenuOverlay(theme, task.id, items, done),
				{
					overlay: true,
					overlayOptions: { anchor: "top-center", offsetY: 10, width: 58, minWidth: 50, maxHeight: 16 },
				},
			);
			if (selected) await this.executeAction(selected);
		} finally {
			this.actionInProgress = false;
			this.invalidateAndRender();
		}
	}

	private async openAgentDetail(): Promise<void> {
		const task = this.selectedTask();
		if (!task) return;
		this.activeTab = "Agent";
		this.actionInProgress = true;
		this.invalidateAndRender();
		try {
			const initialDetail = this.details.get(task.id);
			await this.ui.custom<void>(
				(tui, theme, _keybindings, done) => new AgentDetailOverlay(tui, theme, task, done, initialDetail),
				{
					overlay: true,
					overlayOptions: { anchor: "top-center", offsetY: 5, width: "90%", minWidth: 104, maxHeight: "80%" },
				},
			);
		} finally {
			this.actionInProgress = false;
			this.invalidateAndRender();
			this.scheduleSelectedDetailLoad(0, true);
		}
	}

	private actionItems(task: KanadeTask): ActionItem[] {
		const items: ActionItem[] = [];
		const detail = this.details.get(task.id);
		const review = detail?.review;
		switch (taskActionState(task, review)) {
			case "needs_human":
				items.push({ key: "respond", label: "Respond to human request" });
				items.push({ key: "abort", label: "Abort task", danger: true });
				break;
			case "active":
				items.push({ key: "abort", label: "Abort task", danger: true });
				break;
			case "merge_ready":
				items.push({ key: "merge", label: "Merge task", danger: true });
				items.push({ key: "iterate", label: "Iterate with instructions" });
				break;
			case "finished_review":
				items.push({ key: "iterate", label: "Iterate with instructions" });
				break;
			case "terminal_preserved":
				items.push({ key: "recovery", label: "Open recovery view" });
				items.push({ key: "reconcile", label: "Reconcile manual merge" });
				items.push({ key: "iterate", label: "Iterate with instructions" });
				items.push({ key: "reject", label: "Cleanup preserved worktree", danger: true });
				break;
			case "terminal_merged":
				items.push({ key: "recovery", label: "Open merge summary" });
				break;
			case "terminal_cleaned":
				break;
		}
		items.push({ key: "agent", label: "Open agent detail" });
		items.push({ key: "refresh", label: "Refresh" });
		return dedupeActions(items);
	}

	private handleActionMenuInput(data: string): void {
		if (!this.actionMenu) return;
		if (isKey(data, "escape", "\x1b") || isKey(data, "ctrl+c") || data === "q" || data === "Q") {
			this.actionMenu = undefined;
			this.invalidateAndRender();
			return;
		}
		if (isKey(data, "up", "\x1b[A", "\x1bOA")) {
			this.actionMenu.selected = Math.max(0, this.actionMenu.selected - 1);
			this.invalidateAndRender();
			return;
		}
		if (isKey(data, "down", "\x1b[B", "\x1bOB")) {
			this.actionMenu.selected = Math.min(this.actionMenu.items.length - 1, this.actionMenu.selected + 1);
			this.invalidateAndRender();
			return;
		}
		if (isKey(data, "return", "\r", "\n") || isKey(data, "enter", "\r", "\n")) {
			const item = this.actionMenu.items[this.actionMenu.selected];
			this.actionMenu = undefined;
			void this.executeAction(item);
		}
	}

	private handleConfirmInput(data: string): void {
		if (!this.confirmDialog) return;
		if (
			isKey(data, "escape", "\x1b") ||
			isKey(data, "ctrl+c") ||
			data === "n" ||
			data === "N" ||
			data === "q" ||
			data === "Q"
		) {
			this.confirmDialog = undefined;
			this.invalidateAndRender();
			return;
		}
		if (isKey(data, "return", "\r", "\n") || isKey(data, "enter", "\r", "\n") || data === "y" || data === "Y") {
			const dialog = this.confirmDialog;
			this.confirmDialog = undefined;
			void this.runPanelAction(dialog.onConfirm);
		}
	}

	private async executeAction(item: ActionItem | undefined): Promise<void> {
		if (!item) return;
		const task = this.selectedTask();
		if (!task) return;
		if (item.key === "merge") {
			const confirmed = await this.confirmOverlay({
				title: `Merge ${task.id}?`,
				message:
					"Only merge after reviewing workflow, diff, commits, validation, usage, and human decisions. This will merge the task worktree into the base branch.",
				confirmLabel: "Merge",
				danger: true,
				onConfirm: () => this.mergeTask(task),
			});
			if (confirmed)
				await this.runPanelAction(() => this.mergeTask(task), {
					label: "Merge in progress",
					detail: `${task.id} · please wait`,
				});
			return;
		}
		if (item.key === "abort") {
			const confirmed = await this.confirmOverlay({
				title: `Abort ${task.id}?`,
				message: "Abort stops the running task. Preserved worktrees may remain for inspection.",
				confirmLabel: "Abort",
				danger: true,
				onConfirm: () => this.abortTask(task),
			});
			if (confirmed)
				await this.runPanelAction(() => this.abortTask(task), {
					label: "Abort in progress",
					detail: task.id,
				});
			return;
		}
		if (item.key === "reject") {
			await this.previewAndCleanupRecovery(task);
			return;
		}
		if (item.key === "respond" || item.key === "iterate") {
			// These actions need Pi's normal select/editor input. Close the overlay first so
			// the input UI is not hidden behind the Cockpit overlay.
			this.close();
			try {
				if (item.key === "respond") await this.respondToHuman(task);
				else await this.iterateTask(task);
			} catch (error) {
				this.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
			return;
		}
		if (item.key === "reconcile") {
			await this.runPanelAction(() => this.reconcileTask(task), {
				label: "Reconcile in progress",
				detail: task.id,
			});
			return;
		}
		if (item.key === "agent") {
			await this.openAgentDetail();
			return;
		}
		await this.runPanelAction(
			async () => {
				if (item.key === "recovery") this.activeTab = "Worktree";
				else if (item.key === "refresh") await this.refresh();
			},
			item.key === "refresh" ? { label: "Refresh in progress" } : undefined,
		);
	}

	private async confirmOverlay(dialog: ConfirmDialog): Promise<boolean> {
		return await this.ui.custom<boolean>((_tui, theme, _keybindings, done) => new ConfirmOverlay(theme, dialog, done), {
			overlay: true,
			overlayOptions: { anchor: "top-center", offsetY: 12, width: "56%", minWidth: 76, maxHeight: 18 },
		});
	}

	private async runPanelAction(
		action: () => Promise<void>,
		operation?: Omit<ActiveOperation, "startedAt">,
	): Promise<void> {
		this.actionInProgress = true;
		this.lastNotice = undefined;
		this.startOperation(operation ?? { label: "Action in progress" });
		try {
			await action();
			this.invalidateAndRender();
			this.scheduleSelectedDetailLoad(0, this.activeTab === "Agent");
		} catch (error) {
			this.lastNotice = { kind: "error", text: error instanceof Error ? error.message : String(error) };
			this.ui.notify(this.lastNotice.text, "error");
		} finally {
			this.actionInProgress = false;
			this.stopOperation();
			this.invalidateAndRender();
		}
	}

	private async respondToHuman(task: KanadeTask): Promise<void> {
		const request = this.overview.inbox.find((item) => item.task_id === task.id);
		if (!request) {
			this.lastNotice = { kind: "warning", text: `No pending human request for ${task.id}` };
			return;
		}
		const title = request.payload?.title ?? `Human request for ${task.id}`;
		const options = request.payload?.options ?? [];
		const choices = [...options, "Custom response...", "Cancel"];
		const choice = await this.ui.select(title, choices);
		if (!choice || choice === "Cancel") return;
		let response: Record<string, unknown>;
		if (choice === "Custom response...") {
			const text = await this.ui.editor(`Respond to ${task.id}`, request.payload?.detail ?? "");
			if (!text?.trim()) return;
			response = { freeform: text.trim() };
		} else {
			response = { decision: choice };
		}
		await postJson(`/tasks/${encodeURIComponent(task.id)}/respond`, { request_id: request.request_id, response });
		this.ui.notify(`Responded to ${task.id}`, "info");
		await this.refresh();
	}

	private async iterateTask(task: KanadeTask): Promise<void> {
		const prompt =
			task.status === "failed" || task.status === "aborted"
				? "Inspect preserved worktree/agent history, recover useful work, then continue."
				: "Continue from the current result with these instructions.";
		const instructions = await this.ui.editor(`Iterate ${task.id}`, prompt);
		if (!instructions?.trim()) return;
		const result = await postJson<{ task_id?: string }>(`/tasks/${encodeURIComponent(task.id)}/iterate`, {
			instructions: instructions.trim(),
		});
		this.ui.notify(`Created iteration ${result.task_id ?? ""}`.trim(), "info");
		await this.refresh();
	}

	private async mergeTask(task: KanadeTask): Promise<void> {
		await postJson(`/tasks/${encodeURIComponent(task.id)}/merge`, {});
		this.lastNotice = { kind: "info", text: `Merged ${task.id} into base branch.` };
		this.ui.notify(`Merged ${task.id}`, "info");
		await this.refresh();
	}

	private async abortTask(task: KanadeTask): Promise<void> {
		await postJson(`/tasks/${encodeURIComponent(task.id)}/abort`, {});
		this.ui.notify(`Abort requested for ${task.id}`, "warning");
		await this.refresh();
	}

	private async previewAndCleanupRecovery(task: KanadeTask): Promise<void> {
		let preview: RecoveryCleanupResult;
		try {
			preview = await postJson<RecoveryCleanupResult>("/recovery/cleanup", { task_id: task.id });
		} catch (error) {
			this.lastNotice = { kind: "error", text: error instanceof Error ? error.message : String(error) };
			this.ui.notify(this.lastNotice.text, "error");
			this.invalidateAndRender();
			return;
		}
		if (preview.matched === 0) {
			this.lastNotice = { kind: "warning", text: `No preserved recovery worktree matched ${task.id}` };
			this.ui.notify(this.lastNotice.text, "warning");
			this.invalidateAndRender();
			return;
		}
		const summary = preview.tasks[0]?.worktree_summary ?? task.worktree_summary;
		const target = [summary?.branch, summary?.path].filter(Boolean).join(" · ") || task.id;
		const confirmed = await this.confirmOverlay({
			title: `Cleanup preserved worktree for ${task.id}?`,
			message: `Dry-run matched ${preview.matched} preserved recovery item(s): ${target}. This will remove the preserved worktree/branch and mark the task rejected. Prefer inspect or iterate first if partial work may be useful.`,
			confirmLabel: "Cleanup preserved worktree",
			danger: true,
			onConfirm: () => this.cleanupRecoveryTask(task),
		});
		if (confirmed)
			await this.runPanelAction(() => this.cleanupRecoveryTask(task), {
				label: "Cleanup in progress",
				detail: task.id,
			});
	}

	private async cleanupRecoveryTask(task: KanadeTask): Promise<void> {
		const result = await postJson<RecoveryCleanupResult>("/recovery/cleanup", {
			task_id: task.id,
			execute: true,
			confirmed: true,
		});
		this.lastNotice = { kind: "info", text: `Cleaned ${result.cleaned} preserved worktree(s) for ${task.id}` };
		this.ui.notify(`Cleaned preserved worktree for ${task.id}`, "warning");
		await this.refresh();
	}

	private async reconcileTask(task: KanadeTask): Promise<void> {
		const result = await postJson<{ mergeCommit?: string; state?: string }>(
			`/tasks/${encodeURIComponent(task.id)}/reconcile`,
			{},
		);
		const suffix = result.mergeCommit ? ` (${result.mergeCommit.slice(0, 12)})` : "";
		this.lastNotice = { kind: "info", text: `Reconciled ${task.id} as ${result.state ?? "merged"}${suffix}` };
		this.ui.notify(`Reconciled ${task.id}${suffix}`, "info");
		await this.refresh();
	}

	private actionMenuLines(width: number): string[] {
		const menu = this.actionMenu;
		if (!menu) return [];
		const task = this.overview.tasks.find((candidate) => candidate.id === menu.taskId) ?? this.selectedTask();
		const lines = [this.color("muted", `Actions${task ? ` · ${task.id}` : ""}`)];
		for (let i = 0; i < menu.items.length; i++) {
			const item = menu.items[i];
			const selected = i === menu.selected;
			const prefix = selected ? this.color("accent", "▸") : " ";
			const label = item.danger
				? this.color("error", item.label)
				: selected
					? this.color("accent", item.label)
					: item.label;
			lines.push(truncateAnsi(`${prefix} ${label}`, width));
		}
		lines.push(this.color("dim", "↑↓ select   Enter run   Esc cancel"));
		return lines;
	}

	private confirmDialogLines(width: number): string[] {
		const dialog = this.confirmDialog;
		if (!dialog) return [];
		const title = dialog.danger ? this.color("error", dialog.title) : this.color("warning", dialog.title);
		const lines = [title];
		for (const line of wrapPlain(dialog.message, width).slice(0, 4)) lines.push(this.color("dim", line));
		lines.push("");
		lines.push(
			`${this.color(dialog.danger ? "error" : "warning", `Enter / y: ${dialog.confirmLabel}`)}    ${this.color("dim", "Esc / n: cancel")}`,
		);
		return lines;
	}

	private renderWide(body: string[], width: number): void {
		this.taskLimit = MAX_VISIBLE_TASKS;
		const leftWidth = Math.min(40, Math.max(30, Math.floor(width * 0.38)));
		const rightWidth = width - leftWidth - 3;
		const taskLines = this.taskLines(leftWidth);
		const detailLines = this.detailLines(rightWidth);
		const naturalRows = Math.max(taskLines.length, detailLines.length, 12);
		const reservedRows = Math.max(12, PANEL_BODY_ROWS - 3);
		const rows = Math.max(naturalRows, reservedRows);
		for (let i = 0; i < rows; i++) {
			const left = padAnsi(taskLines[i] ?? "", leftWidth);
			const right = truncateAnsi(detailLines[i] ?? "", rightWidth);
			body.push(`${left} ${this.color("dim", "│")} ${right}`);
		}
	}

	private renderNarrow(body: string[], width: number): void {
		this.taskLimit = MAX_VISIBLE_NARROW_TASKS;
		const taskLines = this.taskLines(width);
		const detailLines = this.detailLines(width);
		if (this.actionMenu || this.confirmDialog) {
			body.push(...taskLines.slice(0, 10));
			body.push(rule(width, this.theme));
			body.push(...detailLines.slice(0, 8));
			return;
		}
		body.push(...taskLines);
		body.push(rule(width, this.theme));
		body.push(...detailLines);
	}

	private taskLines(width: number): string[] {
		const view = this.filteredTasks();
		this.selected = Math.min(this.selected, Math.max(0, view.tasks.length - 1));
		const total = view.total;
		const visibleTasks = view.tasks.length;
		const suffix = view.query ? ` · ${total} match(es)` : total > visibleTasks ? ` · top ${visibleTasks}/${total}` : "";
		const lines: string[] = [this.color("muted", `Tasks (${this.overview.tasks.length})${suffix}`)];
		if (this.searchMode || this.searchQuery.length > 0) {
			const cursor = this.searchMode ? "▏" : "";
			lines.push(this.color("dim", `search: ${this.searchQuery}${cursor}`));
		}
		if (total === 0) {
			lines.push(this.color("dim", "No tasks found. Backspace to clear search."));
			return lines;
		}
		for (let row = 0; row < visibleTasks; row++) {
			const task = view.tasks[row];
			if (!task) break;
			const selected = row === this.selected;
			const prefix = selected ? this.color("accent", "▸") : " ";
			const icon = this.statusIcon(task.status);
			const titleWidth = Math.max(8, width - 16);
			const title = selected ? this.color("warning", taskTitle(task, titleWidth)) : taskTitle(task, titleWidth);
			lines.push(`${prefix} ${icon} ${task.id} ${title}`);
			const metaParts = [
				String(task.status),
				taskWorktreeHint(task),
				relativeTime(task.finished_at ?? task.started_at ?? task.created_at),
			].filter(Boolean);
			lines.push(this.color("dim", truncatePlain(`    ${metaParts.join(" · ")}`, width)));
			if (row < visibleTasks - 1) lines.push(this.color("dim", ""));
		}
		if (!view.query && total > visibleTasks) {
			lines.push(this.color("dim", `Press / to filter by task id/status/title · ${total - visibleTasks} hidden`));
		} else if (view.query && total > visibleTasks) {
			lines.push(this.color("dim", `${total - visibleTasks} more match(es). Refine filter.`));
		}
		return lines;
	}

	private detailLines(width: number): string[] {
		const task = this.selectedTask();
		if (!task) return [this.color("muted", "Detail"), this.color("dim", "Select a task.")];
		if (this.actionMenu) return this.actionMenuLines(width);
		if (this.confirmDialog) return this.confirmDialogLines(width);
		const detail = this.details.get(task.id);
		const lines: string[] = [];
		const taskDuration = taskDurationLabel(task);
		const status = `${task.status}${taskDuration ? ` · ${taskDuration}` : relativeTime(task.started_at) ? ` · ${relativeTime(task.started_at)}` : ""}`;
		const titleText = `${task.id} · ${taskTitle(task, Math.max(12, width - 30))}`;
		const pad = Math.max(1, width - visibleWidth(titleText) - visibleWidth(status));
		lines.push(`${titleText}${" ".repeat(pad)}${status}`);
		lines.push(this.renderTabs(width));
		lines.push("");
		if (detail?.loading) lines.push(`${this.color("dim", "Loading")} task detail...`);
		if (detail?.error) lines.push(this.color("warning", truncatePlain(detail.error, width)));
		if (this.activeTab === "Map") lines.push(...this.mapLines(task, detail, width));
		else if (this.activeTab === "Agent") lines.push(...this.agentLines(task, detail, width));
		else if (this.activeTab === "Events") lines.push(...this.eventLines(task, detail, width));
		else if (this.activeTab === "Worktree") lines.push(...this.worktreeLines(task, detail, width));
		else if (this.activeTab === "Usage") lines.push(...this.usageLines(detail, width));
		else if (this.activeTab === "Result") lines.push(...this.resultLines(task, width));
		else if (this.activeTab === "Review") lines.push(...this.reviewLines(task, detail, width));
		return lines;
	}

	private renderTabs(width: number): string {
		return truncateAnsi(
			TABS.map((tab) => (tab === this.activeTab ? this.color("accent", `[${tab}]`) : this.color("muted", tab))).join(
				"  ",
			),
			width,
		);
	}

	private mapLines(task: KanadeTask, detail: TaskDetail | undefined, width: number): string[] {
		const snapshot = detail?.snapshot;
		if (detail?.workflowPlan?.length) return this.workflowPlanLines(task, detail, width);
		if (snapshot?.agents?.length) return this.snapshotMapLines(task, snapshot, width);
		if (task.status === "running") {
			return [
				`${this.color("success", "✓")} 1 Workflow prepared`,
				this.color("dim", "  │"),
				this.color("dim", "  ▼"),
				`${this.color("accent", "active")} 2 Runtime executing`,
				this.color("dim", "    Detailed graph events will appear as Kanade emits them."),
			];
		}
		if (task.status === "needs_human") {
			const req = this.overview.inbox.find((item) => item.task_id === task.id);
			return [
				`${this.color("success", "✓")} 1 Runtime reached human gate`,
				this.color("dim", "  │"),
				this.color("dim", "  ▼"),
				`${this.color("warning", "?")} 2 Human decision required`,
				this.color("dim", `    ${truncatePlain(req?.payload?.title ?? "waiting for response", width - 4)}`),
			];
		}
		if (task.status === "failed" || task.status === "aborted") {
			return [
				`${this.color("error", "×")} Workflow stopped`,
				this.color("dim", `    ${sanitizeText(truncatePlain(task.error ?? "No error recorded", width - 4))}`),
				this.color("warning", "    Recommended: inspect agent history/worktree, iterate, or keep."),
			];
		}
		if (task.status === "finished") {
			return [
				`${this.color("success", "✓")} Workflow finished`,
				this.color("dim", "    Do not merge from status alone."),
				this.color("dim", "    Inspect workflow, diff, checks, evidence, usage, and human decisions."),
			];
		}
		return [this.color("dim", "Workflow Runtime will appear as the task executes.")];
	}

	private workflowPlanLines(task: KanadeTask, detail: TaskDetail, width: number): string[] {
		const snapshot = detail.snapshot;
		const isTerminalTask = task.status === "finished" || task.status === "failed" || task.status === "aborted";
		const currentPhase = isTerminalTask ? undefined : snapshot?.currentPhase;
		const runtimeAgents = snapshot?.agents ?? [];
		const phases: Array<{ phase: string; steps: WorkflowPlanStep[] }> = [];
		for (const step of detail.workflowPlan ?? []) {
			let group = phases.find((candidate) => candidate.phase === step.phase);
			if (!group) {
				group = { phase: step.phase, steps: [] };
				phases.push(group);
			}
			group.steps.push(step);
		}
		const currentIndex = phases.findIndex((group) => group.phase === currentPhase);
		const lines = [this.color("muted", "Workflow Plan")];
		for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex++) {
			const group = phases[phaseIndex];
			const conditional = group.steps.some((step) => step.conditional);
			const phaseAgents = runtimeAgents.filter((agent) => agent.phase === group.phase);
			const hasRunning = phaseAgents.some((agent) => agent.status === "running");
			const hasError = phaseAgents.some((agent) => agent.status === "error");
			const isCurrent = currentPhase === group.phase || hasRunning;
			const isDone = currentIndex >= 0 && phaseIndex < currentIndex;
			const icon = hasError
				? this.color("error", "×")
				: isCurrent
					? this.color("accent", "current")
					: isDone || task.status === "finished"
						? this.color("success", "✓")
						: this.color("dim", "○");
			if (conditional) lines.push(this.color("dim", `condition: ${phaseConditionLabel(group.phase)}`));
			const phaseLabel = isCurrent ? this.color("accent", group.phase) : group.phase;
			lines.push(`${conditional ? "  " : ""}${icon} Phase: ${truncatePlain(phaseLabel, width - 14)}`);
			for (const step of group.steps) {
				const agent = phaseAgents.find((candidate) => helperMatchesAgent(step, candidate)) ?? phaseAgents.at(0);
				const agentStatus = agent?.status ?? (isDone ? "done" : isCurrent ? "running" : "planned");
				const agentIcon =
					agentStatus === "running"
						? this.color("accent", "running")
						: agentStatus === "error"
							? this.color("error", "×")
							: agentStatus === "done"
								? this.color("success", "✓")
								: this.color("dim", "○");
				const agentLabel = agent?.label ?? step.label;
				const agentDuration = agent ? nodeDurationLabel(agent, isTerminalTask) : "";
				lines.push(
					`${conditional ? "  " : ""}${this.color("dim", "└─")} ${agentIcon} Agent: ${truncatePlain(agentLabel, width - 24)}${this.color("dim", ` · ${agentStatus}${agentDuration ? ` · ${agentDuration}` : ""}`)}`,
				);
			}
			if (phaseIndex < phases.length - 1) lines.push(this.color("dim", "│"));
		}
		if (!isTerminalTask && snapshot?.graph?.cursorNodeId) {
			lines.push(this.color("dim", `Current: ${currentPhase ?? "runtime"}`));
		}
		return lines;
	}

	private snapshotMapLines(task: KanadeTask, snapshot: WorkflowSnapshot, width: number): string[] {
		if (snapshot.graph?.nodes?.length) return this.graphMapLines(task, snapshot.graph, width);

		const lines: string[] = [];
		lines.push(this.color("muted", "Workflow Runtime"));
		const phases = snapshot.phases.length > 0 ? snapshot.phases : [snapshot.currentPhase ?? snapshot.name];
		phases.slice(0, 8).forEach((phase, index) => {
			const phaseAgents = snapshot.agents.filter(
				(agent) => agent.phase === phase || (!agent.phase && phases.length === 1),
			);
			const isCurrent = snapshot.currentPhase === phase || phaseAgents.some((agent) => agent.status === "running");
			const hasError = phaseAgents.some((agent) => agent.status === "error");
			const icon = hasError
				? this.color("error", "×")
				: isCurrent
					? this.color("accent", "current")
					: this.color("success", "✓");
			const title = isCurrent ? this.color("accent", phase) : phase;
			lines.push(`${icon} ${index + 1} ${truncatePlain(title, width - 6)}`);
			const summary = summarizePhase(phaseAgents);
			if (summary) lines.push(this.color("dim", `    ${agentSummaryLine(summary, width - 4)}`));
			if (index < phases.length - 1) lines.push(this.color("dim", "  │"));
		});
		if (task.status === "needs_human") {
			lines.push(this.color("dim", "  │"));
			lines.push(`${this.color("warning", "?")} Human decision required`);
		}
		return lines;
	}

	private graphMapLines(task: KanadeTask, graph: WorkflowGraphSnapshot, width: number): string[] {
		const lines = [this.color("muted", "Workflow Runtime")];
		const terminal = task.status === "finished" || task.status === "failed" || task.status === "aborted";
		const nodes = graph.nodes.slice(-12);
		for (let index = 0; index < nodes.length; index++) {
			const node = nodes[index];
			const isCursor = !terminal && graph.cursorNodeId === node.id;
			const normalizedNode =
				terminal && (node.status === "running" || node.status === "planned") ? { ...node, status: "done" } : node;
			const icon = this.graphNodeIcon(normalizedNode, isCursor);
			const label = isCursor ? this.color("accent", node.label) : node.label;
			const prefix =
				node.kind === "agent"
					? "  Agent:"
					: node.kind === "phase"
						? "Phase:"
						: node.kind === "human"
							? "Human:"
							: `${node.kind}:`;
			const durationLabel = nodeDurationLabel(normalizedNode, terminal);
			const status =
				node.kind === "agent"
					? this.color("dim", ` · ${normalizedNode.status}${durationLabel ? ` · ${durationLabel}` : ""}`)
					: "";
			lines.push(`${icon} ${prefix} ${truncatePlain(label, width - visibleWidth(`${prefix} `) - 6)}${status}`);
			const summary = node.error ?? node.summary;
			if (summary) {
				const indent = node.kind === "agent" ? "    " : "  ";
				const styledSummary =
					normalizedNode.status === "error"
						? this.color("error", agentSummaryLine(summary, width - indent.length))
						: this.color("dim", agentSummaryLine(summary, width - indent.length));
				lines.push(`${indent}${styledSummary}`);
			}
		}
		return lines;
	}

	private graphNodeIcon(node: WorkflowGraphNode, isCursor: boolean): string {
		if (node.status === "running" || isCursor) return this.color("accent", "current");
		if (node.status === "done") return this.color("success", "✓");
		if (node.status === "warning") return this.color("warning", "?");
		if (node.status === "error") return this.color("error", "×");
		return this.color("dim", "○");
	}

	private agentLines(task: KanadeTask, detail: TaskDetail | undefined, width: number): string[] {
		const lines: string[] = [];
		const snapshotAgents = detail?.snapshot?.agents ?? [];
		const sessions = detail?.sessions ?? [];
		const activeAgent = snapshotAgents.find((agent) => agent.status === "running") ?? snapshotAgents.at(-1);
		if (activeAgent) {
			const icon =
				activeAgent.status === "running"
					? this.color("accent", "running")
					: activeAgent.status === "error"
						? this.color("error", "×")
						: this.color("success", "✓");
			lines.push(
				`${this.color("muted", "Agent:")} ${icon} ${truncatePlain(activeAgent.label, width - 12)} · ${activeAgent.status}`,
			);
			if (activeAgent.resultPreview) lines.push(this.color("dim", agentSummaryLine(activeAgent.resultPreview, width)));
		} else {
			lines.push(this.color("muted", "Agent"));
			lines.push(this.color("dim", "No agent snapshot yet."));
		}
		if (detail?.sessionLabel) lines.push(this.color("dim", `Session: ${detail.sessionLabel}`));
		else if (sessions.length > 0) lines.push(this.color("dim", `Sessions: ${sessions.map((s) => s.label).join(", ")}`));
		if (snapshotAgents.length === 0 && sessions.length === 0) {
			lines.push(this.color("dim", "Kanade stores sessions under runs/<task>/debug/subagents."));
			return lines;
		}
		const graph = detail?.snapshot?.graph;
		if (graph) {
			lines.push("");
			lines.push(this.color("muted", "Agent Timing"));
			for (const node of graph.nodes) {
				if (node.kind !== "agent") continue;
				const phase = node.phase ?? "-";
				const status =
					terminalTask(task) && (node.status === "running" || node.status === "planned") ? "done" : node.status;
				const duration = nodeDurationLabel(node, terminalTask(task));
				const icon =
					status === "running"
						? this.color("accent", "▸")
						: status === "done"
							? this.color("success", "✓")
							: status === "error"
								? this.color("error", "×")
								: this.color("dim", "○");
				lines.push(
					truncateAnsi(
						`  ${icon} ${truncatePlain(node.label, 22).padEnd(22)} ${truncatePlain(phase, 14).padEnd(14)} ${status.padEnd(8)} ${duration || "–"}`,
						width,
					),
				);
			}
		}
		lines.push("");
		const events = detail?.sessionEvents ?? [];
		const model = latestSessionModel(events);
		if (model) lines.push(this.color("dim", `Model: ${model}`));
		lines.push(this.color("muted", "Activity"));
		if (events.length === 0) {
			lines.push(
				this.color("dim", task.status === "running" ? "Loading latest session..." : "No session preview loaded."),
			);
			return lines;
		}
		for (const event of events.slice(-MAX_VISIBLE_AGENT_EVENTS)) {
			const label =
				event.state === "running"
					? `running ${eventLabel(event)}`
					: `${event.state === "error" ? "!" : "·"} ${eventLabel(event)}`;
			const labelStyled =
				event.state === "error"
					? this.color("error", label)
					: event.state === "running"
						? this.color("accent", label)
						: this.color("muted", label);
			lines.push(
				`${this.color("dim", event.time.padEnd(8))} ${labelStyled} ${truncatePlain(event.summary, width - 22)}`,
			);
			if (event.detail) lines.push(this.color("dim", `          ${truncatePlain(event.detail, width - 10)}`));
		}
		return lines;
	}

	private eventLines(task: KanadeTask, detail: TaskDetail | undefined, width: number): string[] {
		const lines = [this.color("muted", "Events")];
		const taskEvents = detail?.taskEvents ?? [];
		const logs = detail?.snapshot?.logs ?? [];
		if (taskEvents.length === 0 && logs.length === 0) {
			lines.push(this.color("dim", `Status: ${task.status} · No server events yet.`));
			if (detail?.loading) lines.push(this.color("dim", "Loading events..."));
			return lines;
		}
		if (taskEvents.length > 0) {
			for (const event of taskEvents.slice(-14)) {
				const icon =
					event.type.includes("failed") || event.type.includes("error")
						? this.color("error", "!")
						: event.type.includes("finished") || event.type.includes("merged")
							? this.color("success", "✓")
							: event.type.includes("running") || event.type.includes("started")
								? this.color("accent", "active")
								: this.color("dim", "·");
				lines.push(truncateAnsi(`${event.time} ${icon} ${event.type} ${event.summary}`, width));
			}
		} else {
			for (const log of logs.slice(-14)) lines.push(this.color("dim", truncatePlain(log, width)));
		}
		return lines;
	}

	private worktreeLines(task: KanadeTask, detail: TaskDetail | undefined, width: number): string[] {
		const isTerminalFailure = task.status === "failed" || task.status === "aborted";
		const worktrees = detail?.worktrees ?? [];
		// Prefer review endpoint data which includes git-derived diff details;
		// fall back to lightweight list summary for status display before detail loads.
		const summary = detail?.review?.worktree ?? task.worktree_summary;
		const isMerged = detail?.review?.state === "merged" || summary?.status === "merged";
		const lines = [
			this.color("muted", isTerminalFailure && !isMerged ? "Recovery Center" : isMerged ? "Merge Summary" : "Worktree"),
		];
		if (isTerminalFailure && !isMerged) {
			lines.push(`${this.color("error", "×")} ${task.id} ${taskTitle(task, width - 10)}`);
			lines.push(this.color("dim", `Failure: ${sanitizeText(truncatePlain(task.error ?? "unknown", width - 9))}`));
			lines.push("");
		} else if (isTerminalFailure && isMerged) {
			lines.push(`${this.color("success", "✓")} ${task.id} was manually reconciled as merged`);
			lines.push(this.color("dim", `Original task status: ${task.status}`));
			lines.push("");
		}
		if (summary) {
			lines.push(`${this.color("dim", "Merge")}    ${worktreeStateLabel(task)}`);
			const changeSummary = worktreeDetailLabel(summary);
			if (changeSummary) lines.push(`${this.color("dim", "Changes")}  ${truncatePlain(changeSummary, width - 9)}`);
			if (summary.merge_commit)
				lines.push(`${this.color("dim", "Commit")}   ${truncatePlain(summary.merge_commit, width - 9)}`);
			lines.push("");
		}
		if (isTerminalFailure && !isMerged) lines.push(this.color("muted", "Preserved Assets"));
		if (worktrees.length === 0) {
			lines.push(this.color("dim", "No worktree records found."));
		} else {
			for (const worktree of worktrees.slice(0, 5)) {
				lines.push(`${this.color("dim", "Branch")}   ${truncatePlain(worktree.branch, width - 9)}`);
				lines.push(`${this.color("dim", "Path")}     ${truncatePlain(worktree.worktree_path, width - 9)}`);
				lines.push(
					`${this.color("dim", "Status")}   ${worktree.status}${worktree.merge_commit ? ` · ${worktree.merge_commit}` : ""}`,
				);
				lines.push("");
			}
		}
		if (isTerminalFailure && !isMerged) {
			lines.push(this.color("muted", "Recommended Actions"));
			lines.push("  1. Open agent detail and inspect the failed step");
			lines.push("  2. If branch was manually merged, run Reconcile manual merge");
			lines.push("  3. Iterate with focused recovery instructions");
			lines.push("  4. Keep preserved worktree if partial work may help");
			lines.push(this.color("error", "  5. Reject cleanup only after review"));
		}
		return lines;
	}

	private usageLines(detail: TaskDetail | undefined, width: number): string[] {
		const usage = detail?.usage;
		if (!usage) return [this.color("muted", "Usage"), this.color("dim", "No usage summary recorded yet.")];
		const lines = [this.color("muted", "Usage")];
		const author = usage.author;
		const runtime = usage.runtime;
		if (author || runtime || usage.total) {
			lines.push(`Author Cost  ${formatCost(costTotal(author))}`);
			lines.push(`Agent Cost   ${formatCost(costTotal(runtime))}`);
			lines.push(`Total Cost   ${formatCost(costTotal(usage.total ?? usage))}`);
		} else {
			lines.push(`Total Cost   ${formatCost(costTotal(usage))}`);
		}
		lines.push(`Total Tokens ${formatNumber((usage.total ?? usage).totalTokens)}`);
		lines.push("");
		lines.push(
			this.color(
				"dim",
				truncatePlain(
					`input ${formatNumber(usage.input)} · output ${formatNumber(usage.output)} · cache ${formatNumber(usage.cacheRead)} read / ${formatNumber(usage.cacheWrite)} write`,
					width,
				),
			),
		);
		const agents = usage.agents ?? [];
		if (agents.length > 0) {
			lines.push("");
			lines.push(this.color("muted", "Per-Agent Usage"));
			for (const agent of agents.slice(0, 8)) {
				const label = truncatePlain(agent.label ?? "agent", 20).padEnd(20);
				const phase = truncatePlain(agent.phase ?? agent.role ?? "-", 12).padEnd(12);
				const status = truncatePlain(agent.status ?? "done", 9).padEnd(9);
				const tokens = formatNumber(agent.totalTokens);
				const cost = formatCost(costTotal(agent));
				lines.push(truncateAnsi(`  ${label} ${phase} ${status} ${tokens.padStart(8)} tok  ${cost}`, width));
				if (agent.model) lines.push(this.color("dim", truncatePlain(`    model ${agent.model}`, width)));
			}
			if (agents.length > 8) lines.push(this.color("dim", `  ${agents.length - 8} more agent(s)`));
		}
		return lines;
	}

	private resultLines(task: KanadeTask, width: number): string[] {
		const lines = [this.color("muted", "Result")];
		if (!task.result) {
			lines.push(this.color("dim", "No result yet."));
			return lines;
		}
		for (const line of wrapPlain(String(task.result), width).slice(0, 18)) lines.push(line);
		return lines;
	}

	private reviewLines(_task: KanadeTask, detail: TaskDetail | undefined, width: number): string[] {
		const review = detail?.review;
		if (!review) return [this.color("muted", "Review"), this.color("dim", "Loading review summary...")];

		const lines: string[] = [];
		const stateLabel = reviewStateLabel(review.state);
		const stateColor =
			review.state === "ready"
				? "success"
				: review.state === "merged"
					? "accent"
					: review.state === "blocked" || review.state === "checks_failed"
						? "error"
						: "warning";
		lines.push(`${this.color("muted", "Merge Readiness")}  ${this.color(stateColor, stateLabel)}`);
		lines.push(this.color("dim", sanitizeText(truncatePlain(review.recommendation, width))));
		lines.push(rule(width, this.theme));

		// Checklist
		const checks = review.checks ?? {};
		for (const [key, passed] of Object.entries(checks)) {
			const icon = passed ? this.color("success", "✓") : this.color("error", "×");
			lines.push(`  ${icon} ${checkLabel(key)}`);
		}

		// Blockers
		const blockers = review.blockers ?? [];
		if (blockers.length > 0) {
			lines.push("");
			lines.push(this.color("warning", "Blockers:"));
			for (const blocker of blockers) {
				lines.push(this.color("error", `  ${sanitizeText(truncatePlain(blocker, width - 4))}`));
			}
		}

		// Agent/phase stats
		const reviewData = review.review;
		if (reviewData) {
			lines.push("");
			const agents = reviewData.agents ?? {};
			lines.push(
				this.color("dim", `Agents: ${agents.total ?? 0} total, ${agents.done ?? 0} done, ${agents.failed ?? 0} failed`),
			);
			const phases = reviewData.phases ?? {};
			lines.push(
				this.color("dim", `Phases: ${phases.completed ?? 0} completed, ${phases.in_progress ?? 0} in progress`),
			);
			const gates = reviewData.human_gates ?? {};
			lines.push(this.color("dim", `Human gates: ${gates.resolved ?? 0} resolved, ${gates.pending ?? 0} pending`));
		}

		return lines;
	}

	private async openSettings(): Promise<void> {
		this.lastNotice = undefined;
		this.actionInProgress = true;
		this.invalidateAndRender();
		try {
			const config = await getJson<Record<string, unknown>>("/config");
			await this.ui.custom<void>((tui, theme, _keybindings, done) => new SettingsOverlay(tui, theme, config, done), {
				overlay: true,
				overlayOptions: { anchor: "top-center", offsetY: 3, width: "80%", minWidth: 80, maxHeight: "80%" },
			});
		} catch (error) {
			this.lastNotice = { kind: "error", text: error instanceof Error ? error.message : String(error) };
			this.ui.notify(this.lastNotice.text, "error");
		} finally {
			this.actionInProgress = false;
			this.invalidateAndRender();
		}
	}

	private headerLine(width: number): string {
		const counts = countTasks(this.overview.tasks);
		const status = this.overview.connected
			? `${this.color("success", "●")} connected`
			: `${this.color("error", "×")} offline`;
		const left = `${status}  ${this.color("dim", this.overview.baseUrl)}`;
		const running =
			counts.running > 0 ? `${this.runningToken()}${counts.running} running` : `${this.color("dim", "·")} 0 running`;
		const right = `${running}   ${this.color("warning", "?")} ${counts.needsHuman} waiting   ${this.color("error", "×")} ${counts.failed} failed`;
		const mid = width - visibleWidth(left) - visibleWidth(right);
		return `${left}${" ".repeat(Math.max(1, mid))}${right}`;
	}

	private helpLine(width: number): string {
		const action = this.actionMenu
			? "Enter run action"
			: this.confirmDialog
				? "Enter confirm"
				: this.activeOperation
					? this.activeOperation.label.toLowerCase()
					: this.actionInProgress
						? "action running"
						: "Enter actions";
		const searchHint = this.searchMode
			? "type search · Backspace edit · Enter actions"
			: this.searchQuery.length > 0
				? "Backspace edit search · Esc clear search"
				: "/ search";
		const closeHint = this.searchQuery.length > 0 && !this.searchMode ? "q close" : "Esc close";
		return truncateAnsi(
			this.color(
				"dim",
				`↑↓ select   ${action}   Tab preview   f agent   s settings   ${searchHint}   r refresh   ${closeHint}`,
			),
			width,
		);
	}

	private selectedTask(): KanadeTask | undefined {
		return this.filteredTasks().tasks[this.selected];
	}

	private filteredTasks(): TaskListView {
		const query = this.searchQuery.trim().toLowerCase();
		const tasks = query
			? this.overview.tasks.filter((task) => {
					const haystack = [task.id, taskTitle(task), task.status, task.error ?? "", task.workflow_source ?? ""]
						.join(" ")
						.toLowerCase();
					return haystack.includes(query);
				})
			: this.overview.tasks;
		return { tasks: tasks.slice(0, this.taskLimit), total: tasks.length, query };
	}

	private scheduleSelectedDetailLoad(
		delayMs = 180,
		includeSession = this.activeTab === "Agent",
		includeEvents = this.activeTab === "Events",
	): void {
		if (this.detailLoadTimer) clearTimeout(this.detailLoadTimer);
		const task = this.selectedTask();
		if (!task) return;
		const seq = ++this.detailLoadSeq;
		this.detailLoadTimer = setTimeout(() => {
			void this.loadSelectedDetail(task.id, seq, includeSession, includeEvents);
		}, delayMs);
	}

	private async loadSelectedDetail(
		taskId: string,
		seq: number,
		includeSession: boolean,
		includeEvents: boolean,
	): Promise<void> {
		if (!this.overview.connected || this.closed) return;
		const existing = this.details.get(taskId);
		if (existing?.loading && !includeSession && !includeEvents) return;
		if (
			existing?.loadedAt &&
			Date.now() - existing.loadedAt < 10_000 &&
			(!includeSession || existing.sessionEvents) &&
			(!includeEvents || existing.taskEvents)
		) {
			if (this.selectedTask()?.id === taskId && seq === this.detailLoadSeq) this.invalidateAndRender();
			return;
		}
		this.details.set(taskId, { ...existing, loading: true });
		if (this.selectedTask()?.id === taskId && seq === this.detailLoadSeq) this.invalidateAndRender();
		try {
			const detail = await fetchTaskDetail(taskId, includeSession, includeEvents);
			if (this.closed) return;
			this.details.set(taskId, detail);
		} catch (error) {
			if (this.closed) return;
			this.details.set(taskId, { loading: false, error: error instanceof Error ? error.message : String(error) });
		}
		if (this.selectedTask()?.id === taskId && seq === this.detailLoadSeq) this.invalidateAndRender();
	}

	private statusIcon(status: string): string {
		if (status === "running") return this.color("accent", "running");
		if (status === "needs_human") return this.color("warning", "?");
		if (status === "finished") return this.color("success", "✓");
		if (status === "failed") return this.color("error", "×");
		if (status === "aborted") return this.color("error", "×");
		return this.color("dim", "○");
	}

	private runningToken(): string {
		return `${this.color("accent", "running")} `;
	}

	private activeOperationLine(width: number): string {
		const operation = this.activeOperation;
		if (!operation) return "";
		const elapsedSeconds = Math.max(0, Math.floor((Date.now() - operation.startedAt) / 1000));
		const detail = operation.detail ? ` · ${operation.detail}` : "";
		return truncateAnsi(
			`${this.color("accent", operation.label)}${this.color("dim", `${detail} · ${elapsedSeconds}s elapsed`)}`,
			width,
		);
	}

	private startOperation(operation: Omit<ActiveOperation, "startedAt">): void {
		this.stopOperation();
		this.activeOperation = { ...operation, startedAt: Date.now() };
		this.operationTimer = setInterval(() => this.invalidateAndRender(), 1000);
		this.invalidateAndRender();
	}

	private stopOperation(): void {
		if (this.operationTimer) clearInterval(this.operationTimer);
		this.operationTimer = undefined;
		this.activeOperation = undefined;
	}

	private tickSpinner(): void {}

	private color(kind: "accent" | "success" | "warning" | "error" | "muted" | "dim", text: string): string {
		return this.theme.fg(kind, text);
	}

	private invalidateAndRender(): void {
		if (this.closed) return;
		this.invalidate();
		this.tui.requestRender();
	}
}

function helperMatchesAgent(step: WorkflowPlanStep, agent: WorkflowAgentSnapshot): boolean {
	const label = agent.label.toLowerCase();
	if (step.helper === "implement") return label.includes("implement");
	if (step.helper === "reviewChange") return label.includes("review");
	if (step.helper === "continueImplementation") return label.includes("fix") || label.includes("implement");
	if (step.helper === "testChange") return label.includes("validate") || label.includes("test");
	return false;
}

function phaseConditionLabel(phase: string): string {
	const normalized = phase.toLowerCase();
	if (normalized.includes("review")) return "if review needs_fix";
	if (normalized.includes("validation") || normalized.includes("validate")) return "if validation failed";
	return "conditional";
}

function summarizePhase(agents: WorkflowAgentSnapshot[]): string {
	if (agents.length === 0) return "";
	const running = agents.filter((agent) => agent.status === "running").length;
	const done = agents.filter((agent) => agent.status === "done").length;
	const errors = agents.filter((agent) => agent.status === "error").length;
	const latest = agents.at(-1);
	const parts = [`${done} done`, `${running} running`, `${errors} errors`].filter((part) => !part.startsWith("0 "));
	if (latest?.resultPreview) parts.push(firstLine(latest.resultPreview, 120));
	return parts.join(" · ");
}

function countTasks(tasks: KanadeTask[]): Counts {
	return {
		running: tasks.filter((task) => task.status === "running").length,
		needsHuman: tasks.filter((task) => task.status === "needs_human").length,
		failed: tasks.filter((task) => task.status === "failed" || task.status === "aborted").length,
		finished: tasks.filter((task) => task.status === "finished").length,
	};
}

function taskTitle(task: KanadeTask, max = 80): string {
	return truncatePlain(task.workflow_name || task.workflow_source || "task", max);
}

function taskWorktreeHint(task: KanadeTask): string {
	const summary = task.worktree_summary;
	if (!summary) return task.status === "finished" ? "review/merge" : "";
	return worktreeStateLabel(task);
}

function worktreeStateLabel(task: KanadeTask): string {
	const summary = task.worktree_summary;
	if (!summary) return task.status === "finished" ? "review/merge" : "";
	if (summary.status === "merged") return "merged";
	if (summary.status === "preserved") return "preserved";
	if (summary.status === "rejected") return summary.has_changes || summary.path ? "preserved" : "cleaned";
	if (task.status === "finished") {
		if (summary.status === "active" || summary.status === "inactive") return "review/merge";
		return "no changes";
	}
	if ((task.status === "failed" || task.status === "aborted") && summary.status && summary.status !== "none")
		return "preserved";
	return "";
}

function reviewStateLabel(state: string): string {
	if (state === "ready") return "Ready for merge";
	if (state === "merged") return "Already merged";
	if (state === "preserved") return "Preserved (failed)";
	if (state === "running") return "Running";
	if (state === "blocked") return "Blocked";
	if (state === "no_changes") return "No changes";
	if (state === "checks_failed") return "Checks failed";
	if (state === "checks_missing") return "Checks missing";
	if (state === "needs_review") return "Needs review";
	return "Unknown";
}

function checkLabel(key: string): string {
	const labels: Record<string, string> = {
		task_finished: "Task finished",
		worktree_exists: "Worktree exists",
		has_changes: "Has changes",
		no_agent_errors: "No agent errors",
		all_phases_done: "All phases done",
		human_gates_resolved: "Human gates resolved",
	};
	return labels[key] ?? key;
}

type TaskActionState =
	| "active"
	| "needs_human"
	| "merge_ready"
	| "finished_review"
	| "terminal_preserved"
	| "terminal_merged"
	| "terminal_cleaned";

function taskActionState(task: KanadeTask, review?: ReviewSummary | null): TaskActionState {
	const summary = task.worktree_summary;
	const merged = review?.state === "merged" || summary?.status === "merged";
	if (merged) return "terminal_merged";
	if (task.status === "needs_human") return "needs_human";
	if (task.status === "running" || task.status === "created") return "active";
	if (task.status === "failed" || task.status === "aborted") {
		if (summary?.status === "preserved" || summary?.status === "active" || summary?.status === "inactive") {
			return "terminal_preserved";
		}
		return "terminal_cleaned";
	}
	if (isTaskMergeable(task, review)) return "merge_ready";
	return "finished_review";
}

function isTaskMergeable(task: KanadeTask, review?: ReviewSummary | null): boolean {
	if (task.status !== "finished") return false;
	// If we have review data, use it — no fallback to worktree_summary
	if (review) return review.mergeable === true;
	// Without review data, cannot determine mergeability safely
	return false;
}

function worktreeChangeLabel(summary: WorktreeSummary): string {
	const parts: string[] = [];
	if (typeof summary.changed_files_count === "number" && summary.changed_files_count > 0) {
		parts.push(`${summary.changed_files_count} file${summary.changed_files_count === 1 ? "" : "s"}`);
	}
	if (typeof summary.commit_count === "number" && summary.commit_count > 0) {
		parts.push(`${summary.commit_count} commit${summary.commit_count === 1 ? "" : "s"}`);
	}
	return parts.join(" · ");
}

function worktreeDetailLabel(summary: WorktreeSummary): string {
	if (summary.diff_stat) return summary.diff_stat;
	if (summary.has_changes) return worktreeChangeLabel(summary);
	if (summary.status === "none") return "no worktree";
	return "no diff detected";
}

function relativeTime(ts?: number | null): string {
	if (!ts) return "";
	const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainSec = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainSec}s`;
	const hours = Math.floor(minutes / 60);
	const remainMin = minutes % 60;
	return `${hours}h ${remainMin}m`;
}

function terminalTask(task: KanadeTask): boolean {
	return task.status === "finished" || task.status === "failed" || task.status === "aborted";
}

function taskDurationLabel(task: KanadeTask): string {
	const started = task.started_at ?? task.created_at;
	if (!started) return "";
	const end = task.finished_at;
	if (end) return formatDuration(end - started);
	return `elapsed ${formatDuration(Date.now() - started)}`;
}

function nodeDurationLabel(node: WorkflowGraphNode, isTerminal: boolean): string {
	if (!node.createdAt) return "";
	const end = isTerminal ? (node.updatedAt ?? node.createdAt) : (node.updatedAt ?? node.createdAt);
	const ms = end - node.createdAt;
	if (ms < 1000) return "";
	if (isTerminal) return formatDuration(ms);
	if (node.status === "running") return `elapsed ${formatDuration(Date.now() - node.createdAt)}`;
	return formatDuration(ms);
}

function latestSessionModel(events: SessionEvent[]): string | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event?.label === "model" && event.summary) return event.summary;
	}
	return undefined;
}

function eventLabel(event: SessionEvent): string {
	const label = event.label.replace(/^\[+|\]+$/g, "");
	if (label === "model") return "model";
	if (label === "user") return "user";
	if (label === "text") return "assistant";
	return label;
}

function formatTime(ts?: string | number): string {
	if (!ts) return "        ";
	const date = typeof ts === "number" ? new Date(ts) : new Date(ts);
	if (Number.isNaN(date.getTime())) return "        ";
	return date.toTimeString().slice(0, 8);
}

function firstLine(text: string, max: number): string {
	return truncatePlain(text.replace(/\s+/g, " ").trim(), max);
}

function agentSummaryLine(text: string, max: number): string {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const preferred =
		lines.find((line) => /^[-*]\s*(✅|✓|passed|status|checks?|npm run)/i.test(line)) ??
		lines.find((line) => /passed|clean|no blocking|status:\s*passed|\d+\/\d+/.test(line.toLowerCase())) ??
		lines.find((line) => !line.startsWith("#") && !/^\|?\s*-{3,}/.test(line) && !/^\|.*\|$/.test(line)) ??
		lines[0] ??
		text;
	return firstLine(preferred.replace(/^[-*]\s*/, ""), max);
}

function formatCost(cost?: number): string {
	if (typeof cost !== "number" || !Number.isFinite(cost)) return "$0.0000";
	return `$${cost.toFixed(4)}`;
}

function costTotal(usage?: UsageSummary | null): number | undefined {
	return usage?.cost?.total;
}

function formatNumber(value?: number): string {
	if (typeof value !== "number" || !Number.isFinite(value)) return "0";
	return Math.round(value).toLocaleString();
}

function dedupeActions(values: ActionItem[]): ActionItem[] {
	const seen = new Set<ActionKey>();
	const result: ActionItem[] = [];
	for (const value of values) {
		if (seen.has(value.key)) continue;
		seen.add(value.key);
		result.push(value);
	}
	return result;
}

function padToRight(text: string, pad: number): string {
	return `${" ".repeat(Math.max(1, pad))}${text}`;
}

function rule(width: number, theme: Theme): string {
	return theme.fg("dim", "─".repeat(Math.max(0, width)));
}

function normalizeBodyRows(body: string[], rows: number, _width: number, _theme: Theme): string[] {
	const help = body.at(-1) ?? "";
	const content = body.slice(0, -1);
	if (content.length < rows - 1) {
		return [...content, ...Array.from({ length: rows - 1 - content.length }, () => ""), help];
	}
	if (content.length === rows - 1) return [...content, help];
	return [...content.slice(0, Math.max(0, rows - 1)), help];
}

function fitBodyRows(body: string[], minRows: number, maxRows: number): string[] {
	const help = body.at(-1) ?? "";
	let content = body.slice(0, -1);
	if (content.length > maxRows - 1) content = content.slice(0, Math.max(0, maxRows - 1));
	if (content.length < minRows - 1)
		content = [...content, ...Array.from({ length: minRows - 1 - content.length }, () => "")];
	return [...content, help];
}

function windowAroundSelection<T>(
	items: T[],
	selected: number,
	rows: number,
): { items: T[]; start: number; end: number } {
	const count = Math.max(1, rows);
	if (items.length <= count) return { items, start: 0, end: items.length };
	const half = Math.floor(count / 2);
	const start = Math.max(0, Math.min(items.length - count, selected - half));
	const end = Math.min(items.length, start + count);
	return { items: items.slice(start, end), start, end };
}

function box(body: string[], width: number, title: string, theme: Theme): string[] {
	const inner = width - 2;
	const contentWidth = Math.max(0, width - 4);
	const border = (text: string) => theme.fg("dim", text);
	const paint = (line: string) => padAnsi(line, width);
	const titleText = ` ${title} `;
	const topRight = Math.max(0, inner - visibleWidth(titleText));
	const lines = [
		paint(
			`${border("╭")}${border("─".repeat(2))}${theme.fg("muted", titleText)}${border("─".repeat(Math.max(0, topRight - 2)))}${border("╮")}`,
		),
	];
	for (const line of body) lines.push(paint(`${border("│")} ${padAnsi(line, contentWidth)} ${border("│")}`));
	lines.push(paint(`${border("╰")}${border("─".repeat(inner))}${border("╯")}`));
	return lines;
}

function padAnsi(text: string, width: number): string {
	const clipped = truncateAnsi(text, width);
	return clipped + CLEAR_CELL.repeat(Math.max(0, width - visibleWidth(clipped)));
}

function truncateAnsi(text: string, maxWidth: number, suffix = "…"): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;
	const target = Math.max(0, maxWidth - visibleWidth(suffix));
	let width = 0;
	let output = "";
	for (let i = 0; i < text.length; ) {
		if (text.charCodeAt(i) === 0x1b) {
			const match = ANSI_SGR_PREFIX.exec(text.slice(i));
			if (match) {
				output += match[0];
				i += match[0].length;
				continue;
			}
		}
		const cp = text.codePointAt(i);
		if (cp === undefined) break;
		const char = String.fromCodePoint(cp);
		const charW = charWidth(cp);
		if (width + charW > target) break;
		output += char;
		width += charW;
		i += char.length;
	}
	return output + suffix;
}

function truncatePlain(text: string, maxWidth: number): string {
	return stripAnsi(truncateAnsi(text, maxWidth));
}

function wrapPlain(text: string, width: number): string[] {
	const plain = stripAnsi(text);
	const lines: string[] = [];
	for (const raw of plain.split("\n")) {
		let rest = raw.trimEnd();
		if (!rest) {
			lines.push("");
			continue;
		}
		while (visibleWidth(rest) > width) {
			lines.push(truncatePlain(rest, width));
			rest = rest.slice(stripAnsi(lines.at(-1) ?? "").length).trimStart();
		}
		lines.push(rest);
	}
	return lines;
}

function visibleWidth(text: string): number {
	let width = 0;
	const stripped = stripAnsi(text);
	for (let i = 0; i < stripped.length; ) {
		const cp = stripped.codePointAt(i);
		if (cp === undefined) break;
		width += charWidth(cp);
		i += String.fromCodePoint(cp).length;
	}
	return width;
}

function stripAnsi(text: string): string {
	return text.replace(ANSI_SGR_GLOBAL, "");
}

function charWidth(cp: number): number {
	if (cp === 0) return 0;
	if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
	if (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe10 && cp <= 0xfe19) ||
		(cp >= 0xfe30 && cp <= 0xfe6f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6)
	) {
		return 2;
	}
	return 1;
}

function isKey(data: string, key: Parameters<typeof matchesKey>[1], ...fallbacks: string[]): boolean {
	return matchesKey(data, key) || fallbacks.includes(data);
}

async function updateFooterStatus(ctx: { ui: Ui }): Promise<void> {
	const overview = await fetchOverview();
	if (!overview.connected) {
		ctx.ui.setStatus("kanade", ctx.ui.theme.fg("error", "K: offline"));
		return;
	}
	const counts = countTasks(overview.tasks);
	const waiting = overview.inbox[0];
	if (waiting) {
		ctx.ui.setStatus(
			"kanade",
			`${ctx.ui.theme.fg("warning", "K: ?")} ${ctx.ui.theme.fg("dim", `${waiting.task_id} waiting`)}`,
		);
		return;
	}
	ctx.ui.setStatus(
		"kanade",
		`${ctx.ui.theme.fg("success", "K: ●")} ${ctx.ui.theme.fg("dim", `${counts.running} running · ${counts.needsHuman} waiting · ${counts.failed} failed`)}`,
	);
}

export default function kanadeExtension(pi: ExtensionAPI) {
	let statusTimer: ReturnType<typeof setInterval> | undefined;

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		await updateFooterStatus(ctx);
		if (statusTimer) clearInterval(statusTimer);
		statusTimer = setInterval(() => void updateFooterStatus(ctx), 10_000);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (statusTimer) clearInterval(statusTimer);
		statusTimer = undefined;
		if (ctx.hasUI) ctx.ui.setStatus("kanade", undefined);
	});

	pi.registerCommand("kanade", {
		description: "Open the Kanade cockpit",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/kanade requires Pi TUI mode", "error");
				return;
			}

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					const panel = new KanadePanel(tui, theme, ctx.ui, done);
					void panel.refresh();
					return panel;
				},
				{
					overlay: true,
					overlayOptions: {
						width: "94%",
						minWidth: 96,
						maxHeight: "86%",
						anchor: "top-center",
						offsetY: 1,
						margin: 1,
					},
				},
			);
		},
	});
}
