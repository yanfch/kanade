import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type TaskStatus = "created" | "running" | "needs_human" | "finished" | "aborted" | "failed";
export type Theme = ExtensionCommandContext["ui"]["theme"];
export type Ui = ExtensionCommandContext["ui"];
export type TuiHandle = { requestRender(): void };

export type ServerEvent = { id: number; type: string; taskId?: string; data: unknown; ts: number };
export type TaskEvent = { time: string; type: string; summary: string; ts: number };
export type AgentTiming = { startedAt?: number; elapsedMs?: number; lastActivityAt?: number; idleMs?: number };

export type Component = {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate(): void;
};

export type WorktreeSummary = {
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

export type KanadeTask = {
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

export type InboxRequest = {
	request_id: string;
	task_id: string;
	cache_key?: string;
	payload?: { title?: string; detail?: string; options?: string[]; data?: Record<string, unknown> };
	status?: string;
	created_at?: number;
	resolved_at?: number | null;
	response?: unknown;
};

export type UsageAgent = {
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

export type UsageSummary = {
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

export type WorkflowAgentSnapshot = {
	id: number;
	label: string;
	phase?: string;
	prompt: string;
	status: "queued" | "running" | "done" | "error" | "skipped" | string;
	resultPreview?: string;
	error?: string;
};

export type WorkflowGraphNode = {
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

export type WorkflowGraphSnapshot = {
	nodes: WorkflowGraphNode[];
	edges: Array<{ id: string; from: string; to: string; label?: string; status?: string }>;
	cursorNodeId?: string;
};

export type WorkflowSnapshot = {
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

export type WorktreeRow = {
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

export type SessionListItem = { label: string; files: string[]; paths?: string[] };

export type SessionEntry = {
	type?: string;
	timestamp?: string | number;
	message?: {
		role?: string;
		content?: Array<Record<string, unknown>>;
	};
	provider?: string;
	modelId?: string;
};

export type SessionEvent = {
	time: string;
	rawTs?: number;
	label: string;
	summary: string;
	detail?: string;
	state?: "running" | "done" | "error" | "neutral";
};

export type WorkflowPlanStep = {
	phase: string;
	helper: string;
	label: string;
	conditional: boolean;
};

export type ReviewSummary = {
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

export type TaskDetail = {
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

export type KanadeOverview = {
	connected: boolean;
	baseUrl: string;
	tasks: KanadeTask[];
	inbox: InboxRequest[];
	error?: string;
};

export type TaskListView = {
	tasks: KanadeTask[];
	total: number;
	query: string;
};

export type Tab = "Map" | "Agent" | "Events" | "Worktree" | "Usage" | "Result" | "Review";
export type Counts = { running: number; needsHuman: number; failed: number; finished: number };

export type ActionKey =
	| "respond"
	| "iterate"
	| "merge"
	| "save"
	| "reconcile"
	| "abort"
	| "reject"
	| "recovery"
	| "agent"
	| "refresh"
	| "settings";

export type ActionItem = {
	key: ActionKey;
	label: string;
	danger?: boolean;
};

export type ActiveOperation = {
	label: string;
	detail?: string;
	startedAt: number;
};

export type RecoveryCleanupResult = {
	dry_run: boolean;
	matched: number;
	cleaned: number;
	tasks: Array<{ id?: string; worktree_summary?: WorktreeSummary }>;
};

export type ConfirmDialog = {
	title: string;
	message: string;
	confirmLabel: string;
	danger?: boolean;
	onConfirm: () => Promise<void>;
};

export type SettingsFieldType = "boolean" | "number" | "string" | "json" | "record";

export type SettingsFieldDef = {
	key: string;
	section: string;
	label: string;
	type: SettingsFieldType;
	dangerous?: boolean;
	readOnly?: boolean;
};

export type SettingsGroup = { section: string; label: string; fields: SettingsFieldDef[] };
export type SettingsDisplayItem =
	| { kind: "section"; groupIndex: number; label: string; expanded: boolean; fieldCount: number }
	| { kind: "field"; groupIndex: number; field: SettingsFieldDef };
