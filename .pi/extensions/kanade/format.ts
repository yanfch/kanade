import { truncatePlain } from "./tui.ts";
import type {
	ActionItem,
	AgentTiming,
	Counts,
	KanadeTask,
	ReviewSummary,
	SessionEvent,
	UsageSummary,
	WorkflowAgentSnapshot,
	WorkflowGraphNode,
	WorkflowPlanStep,
	WorktreeSummary,
} from "./types.ts";

// Sanitize text for safe single-line rendering: strip control chars and collapse whitespace
export function sanitizeText(text: unknown): string {
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

export function helperMatchesAgent(step: WorkflowPlanStep, agent: WorkflowAgentSnapshot): boolean {
	const label = agent.label.toLowerCase();
	if (step.helper === "implement") return label.includes("implement");
	if (step.helper === "reviewChange") return label.includes("review");
	if (step.helper === "continueImplementation") return label.includes("fix") || label.includes("implement");
	if (step.helper === "testChange") return label.includes("validate") || label.includes("test");
	return false;
}

export function phaseConditionLabel(phase: string): string {
	const normalized = phase.toLowerCase();
	if (normalized.includes("review")) return "if review needs_fix";
	if (normalized.includes("validation") || normalized.includes("validate")) return "if validation failed";
	return "conditional";
}

export function summarizePhase(agents: WorkflowAgentSnapshot[]): string {
	if (agents.length === 0) return "";
	const running = agents.filter((agent) => agent.status === "running").length;
	const done = agents.filter((agent) => agent.status === "done").length;
	const errors = agents.filter((agent) => agent.status === "error").length;
	const latest = agents.at(-1);
	const parts = [`${done} done`, `${running} running`, `${errors} errors`].filter((part) => !part.startsWith("0 "));
	if (latest?.resultPreview) parts.push(firstLine(latest.resultPreview, 120));
	return parts.join(" · ");
}

export function countTasks(tasks: KanadeTask[]): Counts {
	return tasks.reduce(
		(acc, task) => {
			if (task.status === "running" || task.status === "created") acc.running++;
			else if (task.status === "needs_human") acc.needsHuman++;
			else if (task.status === "finished") acc.finished++;
			else if (task.status === "failed" || task.status === "aborted") acc.failed++;
			return acc;
		},
		{ running: 0, needsHuman: 0, failed: 0, finished: 0 },
	);
}

export function sanitizeWorkflowName(value: string): string {
	const cleaned = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 64);
	return cleaned || "generated_workflow";
}

export function taskTitle(task: KanadeTask, max = 80): string {
	return truncatePlain(task.workflow_name || task.workflow_source || task.id, max);
}

export function taskWorktreeHint(task: KanadeTask): string {
	const summary = task.worktree_summary;
	if (!summary) return task.status === "finished" ? "review/merge" : "";
	if (summary.status === "merged") return "merged";
	if (summary.status === "rejected") return summary.count && summary.count > 0 ? "rejected preserved" : "rejected";
	if (summary.status === "preserved") return "preserved";
	if (summary.status === "none") return "no worktree";
	if (summary.status === "active" || summary.status === "inactive") return "review/merge";
	return summary.status ?? "";
}

export function worktreeStateLabel(task: KanadeTask): string {
	const summary = task.worktree_summary;
	if (!summary) return task.status === "finished" ? "review/merge" : "";
	if (summary.status === "merged") return "merged";
	if (summary.status === "rejected") return summary.count && summary.count > 0 ? "rejected preserved" : "rejected";
	if (summary.status === "preserved") return "preserved";
	if (summary.status === "none") return "none";
	if (summary.status === "active" || summary.status === "inactive") return "review/merge";
	return summary.status ?? "unknown";
}

export function reviewStateLabel(state: string): string {
	if (state === "ready") return "Ready for merge";
	if (state === "merged") return "Already merged";
	if (state === "blocked") return "Blocked";
	if (state === "checks_failed") return "Checks failed";
	if (state === "no_changes") return "No changes";
	return state.replace(/_/g, " ");
}

export function checkLabel(key: string): string {
	return key
		.replace(/_/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase())
		.replace("Task Finished", "Task finished")
		.replace("Worktree Exists", "Worktree exists")
		.replace("Has Changes", "Has changes")
		.replace("No Agent Errors", "No agent errors")
		.replace("All Phases Done", "All phases done")
		.replace("Human Gates Resolved", "Human gates resolved");
}

export type TaskActionState =
	| "needs_human"
	| "active"
	| "merge_ready"
	| "finished_review"
	| "terminal_preserved"
	| "terminal_merged"
	| "terminal_cleaned";

export function taskActionState(task: KanadeTask, review?: ReviewSummary | null): TaskActionState {
	const summary = task.worktree_summary;
	const merged = review?.state === "merged" || summary?.status === "merged";
	if (merged) return "terminal_merged";
	if (task.status === "needs_human") return "needs_human";
	if (task.status === "running" || task.status === "created") return "active";
	if (task.status === "failed" || task.status === "aborted") {
		if (
			summary?.status === "preserved" ||
			((summary?.status === "rejected" || summary?.status) && summary.count && summary.count > 0)
		)
			return "terminal_preserved";
		return "terminal_cleaned";
	}
	if (task.status === "finished" && isTaskMergeable(task, review)) return "merge_ready";
	if (task.status === "finished") return "finished_review";
	return "terminal_cleaned";
}

export function isTaskMergeable(_task: KanadeTask, review?: ReviewSummary | null): boolean {
	if (review) return review.mergeable === true && review.state === "ready";
	// Without review data, cannot determine mergeability safely
	return false;
}

export function worktreeChangeLabel(summary: WorktreeSummary): string {
	const parts: string[] = [];
	if (typeof summary.changed_files_count === "number" && summary.changed_files_count > 0) {
		parts.push(`${summary.changed_files_count} file${summary.changed_files_count === 1 ? "" : "s"}`);
	}
	if (typeof summary.commit_count === "number" && summary.commit_count > 0) {
		parts.push(`${summary.commit_count} commit${summary.commit_count === 1 ? "" : "s"}`);
	}
	return parts.join(" · ");
}

export function worktreeDetailLabel(summary: WorktreeSummary): string {
	if (summary.diff_stat) return summary.diff_stat;
	if (summary.has_changes) return worktreeChangeLabel(summary);
	if (summary.status === "none") return "no worktree";
	return "no diff detected";
}

export function relativeTime(ts?: number | null): string {
	if (!ts) return "";
	const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainSec = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainSec}s`;
	const hours = Math.floor(minutes / 60);
	const remainMin = minutes % 60;
	return `${hours}h ${remainMin}m`;
}

export function terminalTask(task: KanadeTask): boolean {
	return task.status === "finished" || task.status === "failed" || task.status === "aborted";
}

export function taskDurationLabel(task: KanadeTask): string {
	const started = task.started_at ?? task.created_at;
	if (!started) return "";
	const end = task.finished_at;
	if (end) return formatDuration(end - started);
	return `elapsed ${formatDuration(Date.now() - started)}`;
}

export function taskStatusSummaryLabel(task: KanadeTask): string {
	const duration = taskDurationLabel(task);
	if (terminalTask(task)) {
		const end = task.finished_at;
		const verb = task.status === "finished" ? "completed" : task.status;
		return [task.status, duration ? `duration ${duration}` : "", end ? `${verb} ${relativeTime(end)}` : ""]
			.filter(Boolean)
			.join(" · ");
	}
	return [task.status, duration || relativeTime(task.started_at ?? task.created_at)].filter(Boolean).join(" · ");
}

export function agentDetailTimingLabel(task: KanadeTask, timing?: AgentTiming): string {
	if (!timing) return "";
	if (terminalTask(task)) {
		const verb = task.status === "finished" ? "completed" : task.status;
		const end = task.finished_at ?? timing.lastActivityAt;
		return [
			task.status,
			typeof timing.elapsedMs === "number" ? `duration ${formatDuration(timing.elapsedMs)}` : "",
			end ? `${verb} ${relativeTime(end)}` : "",
		]
			.filter(Boolean)
			.join(" · ");
	}
	return [
		task.status,
		typeof timing.elapsedMs === "number" ? `elapsed ${formatDuration(timing.elapsedMs)}` : "",
		timing.lastActivityAt ? `active ${relativeTime(timing.lastActivityAt)}` : "",
	]
		.filter(Boolean)
		.join(" · ");
}

export function nodeDurationLabel(node: WorkflowGraphNode, isTerminal: boolean): string {
	if (!node.createdAt) return "";
	const end = isTerminal ? (node.updatedAt ?? node.createdAt) : (node.updatedAt ?? node.createdAt);
	const ms = end - node.createdAt;
	if (ms < 1000) return "";
	if (isTerminal) return formatDuration(ms);
	if (node.status === "running") return `elapsed ${formatDuration(Date.now() - node.createdAt)}`;
	return formatDuration(ms);
}

export function latestSessionModel(events: SessionEvent[]): string | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event?.label === "model" && event.summary) return event.summary;
	}
	return undefined;
}

export function eventLabel(event: SessionEvent): string {
	const label = event.label.replace(/^\[+|\]+$/g, "");
	if (label === "model") return "model";
	if (label === "user") return "user";
	if (label === "text") return "assistant";
	return label;
}

export function formatTime(ts?: string | number): string {
	if (!ts) return "        ";
	const date = typeof ts === "number" ? new Date(ts) : new Date(ts);
	if (Number.isNaN(date.getTime())) return "        ";
	return date.toTimeString().slice(0, 8);
}

export function firstLine(text: string, max: number): string {
	return truncatePlain(text.replace(/\s+/g, " ").trim(), max);
}

export function agentSummaryLine(text: string, max: number): string {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	return truncatePlain(lines[0] ?? text, max);
}

export function formatCost(cost?: number): string {
	if (typeof cost !== "number") return "-";
	if (cost === 0) return "$0";
	return `$${cost.toFixed(4)}`;
}

export function costTotal(usage?: UsageSummary | null): number | undefined {
	return usage?.cost?.total ?? usage?.total?.cost?.total;
}

export function formatNumber(value?: number): string {
	if (typeof value !== "number") return "-";
	return new Intl.NumberFormat().format(value);
}

export function dedupeActions(values: ActionItem[]): ActionItem[] {
	const seen = new Set<string>();
	return values.filter((value) => {
		if (seen.has(value.key)) return false;
		seen.add(value.key);
		return true;
	});
}
