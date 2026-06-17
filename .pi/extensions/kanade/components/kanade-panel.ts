import {
	fetchInbox,
	fetchOverview,
	fetchTaskDetail,
	fetchTasksOverview,
	getJson,
	kanadeBaseUrl,
	postJson,
} from "../api.ts";
import {
	MAX_VISIBLE_AGENT_EVENTS,
	MAX_VISIBLE_NARROW_TASKS,
	MAX_VISIBLE_TASKS,
	PANEL_BODY_ROWS,
	TABS,
} from "../constants.ts";
import {
	agentSummaryLine,
	checkLabel,
	costTotal,
	countTasks,
	dedupeActions,
	eventLabel,
	formatCost,
	formatNumber,
	helperMatchesAgent,
	latestSessionModel,
	nodeDurationLabel,
	phaseConditionLabel,
	relativeTime,
	reviewStateLabel,
	sanitizeText,
	sanitizeWorkflowName,
	summarizePhase,
	taskActionState,
	taskStatusSummaryLabel,
	taskTitle,
	taskWorktreeHint,
	terminalTask,
	worktreeDetailLabel,
	worktreeStateLabel,
} from "../format.ts";
import {
	box,
	isKey,
	normalizeBodyRows,
	padAnsi,
	rule,
	truncateAnsi,
	truncatePlain,
	visibleWidth,
	wrapPlain,
} from "../tui.ts";
import type {
	ActionItem,
	ActiveOperation,
	Component,
	ConfirmDialog,
	KanadeOverview,
	KanadeTask,
	RecoveryCleanupResult,
	Tab,
	TaskDetail,
	TaskListView,
	Theme,
	TuiHandle,
	Ui,
	WorkflowGraphNode,
	WorkflowGraphSnapshot,
	WorkflowPlanStep,
	WorkflowSnapshot,
} from "../types.ts";
import { ActionMenuOverlay } from "./action-menu.ts";
import { AgentDetailOverlay } from "./agent-detail-overlay.ts";
import { ConfirmOverlay } from "./confirm-overlay.ts";
import { SettingsOverlay } from "./settings-overlay.ts";

export class KanadePanel implements Component {
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
					overlayOptions: { anchor: "top-center", offsetY: 5, width: "88%", minWidth: 104, maxHeight: "72%" },
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
				if (task.workflow_source === "generated") items.push({ key: "save", label: "Save generated workflow" });
				items.push({ key: "iterate", label: "Iterate with instructions" });
				break;
			case "finished_review":
				if (task.workflow_source === "generated") items.push({ key: "save", label: "Save generated workflow" });
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
		if (item.key === "save") {
			await this.saveGeneratedWorkflow(task);
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

	private async saveGeneratedWorkflow(task: KanadeTask): Promise<void> {
		const suggestedName = sanitizeWorkflowName(task.workflow_name ?? taskTitle(task, 48) ?? task.id.toLowerCase());
		const name = (await this.ui.editor(`Save generated workflow from ${task.id}`, suggestedName))?.trim();
		if (!name) return;
		if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
			this.lastNotice = {
				kind: "warning",
				text: "Workflow name must contain only alphanumeric characters, hyphens, and underscores.",
			};
			this.ui.notify(this.lastNotice.text, "warning");
			this.invalidateAndRender();
			return;
		}
		await this.runPanelAction(
			async () => {
				await postJson(`/tasks/${encodeURIComponent(task.id)}/save`, { name });
				this.lastNotice = { kind: "info", text: `Saved generated workflow '${name}'.` };
				this.ui.notify(`Saved workflow ${name}`, "info");
				await this.refresh();
			},
			{ label: "Save workflow in progress", detail: name },
		);
	}

	private async mergeTask(task: KanadeTask): Promise<void> {
		const result = await postJson<{ mergeCommit?: string }>(`/tasks/${encodeURIComponent(task.id)}/merge`, {});
		const suffix = result.mergeCommit ? ` (${result.mergeCommit.slice(0, 12)})` : "";
		this.activeTab = "Worktree";
		this.lastNotice = { kind: "info", text: `Merged ${task.id} into base branch${suffix}. Showing merge summary.` };
		this.ui.notify(`Merged ${task.id}${suffix}`, "info");
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
		const status = taskStatusSummaryLabel(task);
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

export async function updateFooterStatus(ctx: { ui: Ui }): Promise<void> {
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
