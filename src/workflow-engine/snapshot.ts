// Portions of this file are derived from pi-dynamic-workflows
// (https://github.com/Michaelliv/pi-dynamic-workflows), MIT licensed.

import type { WorkflowMeta } from "./runtime.ts";

export type WorkflowAgentStatus = "queued" | "running" | "done" | "error" | "skipped";

export interface WorkflowAgentSnapshot {
	id: number;
	label: string;
	phase?: string;
	prompt: string;
	status: WorkflowAgentStatus;
	resultPreview?: string;
	error?: string;
}

export interface WorkflowSnapshot {
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
}

export function createWorkflowSnapshot(meta: WorkflowMeta): WorkflowSnapshot {
	return {
		name: meta.name,
		description: meta.description,
		phases: meta.phases?.map((phase) => phase.title) ?? [],
		logs: [],
		agents: [],
		agentCount: 0,
		runningCount: 0,
		doneCount: 0,
		errorCount: 0,
	};
}

export function recomputeWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
	const runningCount = snapshot.agents.filter((agent) => agent.status === "running").length;
	const doneCount = snapshot.agents.filter((agent) => agent.status === "done").length;
	const errorCount = snapshot.agents.filter((agent) => agent.status === "error").length;
	return { ...snapshot, agentCount: snapshot.agents.length, runningCount, doneCount, errorCount };
}

export function preview(value: unknown, max = 80): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (!text) return "";
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
