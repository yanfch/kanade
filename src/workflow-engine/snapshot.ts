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

export type WorkflowGraphNodeKind = "phase" | "agent" | "human" | "terminal";
export type WorkflowGraphNodeStatus = "planned" | "running" | "done" | "warning" | "error";

export interface WorkflowGraphNode {
	id: string;
	kind: WorkflowGraphNodeKind;
	label: string;
	status: WorkflowGraphNodeStatus;
	phase?: string;
	summary?: string;
	error?: string;
	createdAt: number;
	updatedAt: number;
}

export interface WorkflowGraphEdge {
	id: string;
	from: string;
	to: string;
	label?: string;
	status?: "planned" | "active" | "done" | "warning" | "error";
	createdAt: number;
}

export interface WorkflowGraphSnapshot {
	nodes: WorkflowGraphNode[];
	edges: WorkflowGraphEdge[];
	cursorNodeId?: string;
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
	graph: WorkflowGraphSnapshot;
}

export function createWorkflowSnapshot(meta: WorkflowMeta): WorkflowSnapshot {
	const now = Date.now();
	const phaseNodes = (meta.phases?.map((phase, index) => ({
		id: phaseNodeId(phase.title),
		kind: "phase" as const,
		label: phase.title,
		status: "planned" as const,
		summary: phase.detail,
		createdAt: now + index,
		updatedAt: now + index,
	})) ?? []) satisfies WorkflowGraphNode[];
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
		graph: {
			nodes: phaseNodes,
			edges: phaseNodes.slice(1).map((node, index) => ({
				id: `edge:${phaseNodes[index].id}->${node.id}`,
				from: phaseNodes[index].id,
				to: node.id,
				status: "planned" as const,
				createdAt: now + index,
			})),
		},
	};
}

export function recomputeWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
	const runningCount = snapshot.agents.filter((agent) => agent.status === "running").length;
	const doneCount = snapshot.agents.filter((agent) => agent.status === "done").length;
	const errorCount = snapshot.agents.filter((agent) => agent.status === "error").length;
	return { ...snapshot, agentCount: snapshot.agents.length, runningCount, doneCount, errorCount };
}

export function phaseNodeId(title: string): string {
	return `phase:${slug(title)}`;
}

export function agentNodeId(id: number): string {
	return `agent:${id}`;
}

export function humanNodeId(requestId: string): string {
	return `human:${slug(requestId)}`;
}

function slug(value: string): string {
	return (
		value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "_")
			.replace(/^_+|_+$/g, "") || "node"
	);
}

export function preview(value: unknown, max = 80): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	if (!text) return "";
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
