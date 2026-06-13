/**
 * SnapshotBuilder — event-driven workflow progress tracker.
 *
 * Subscribes to EventBus events and maintains WorkflowSnapshot state.
 * Runtime has zero knowledge of snapshots — full decoupling via events.
 *
 * Performance: only agent/phase events trigger snapshot updates (not logs).
 */

import type { EventBus, ServerEvent } from "../server/event-bus.ts";
import type { WorkflowMeta } from "./runtime.ts";
import {
	type WorkflowGraphNode,
	type WorkflowGraphNodeStatus,
	type WorkflowSnapshot,
	agentNodeId,
	createWorkflowSnapshot,
	humanNodeId,
	phaseNodeId,
	preview,
	recomputeWorkflowSnapshot,
} from "./snapshot.ts";

export class SnapshotBuilder {
	private readonly snapshots = new Map<string, WorkflowSnapshot>();
	private readonly agentIdCounters = new Map<string, number>();
	private readonly off: () => void;

	constructor(private readonly events: EventBus) {
		this.off = this.events.onAny((event) => this.handleEvent(event));
	}

	/** Stop listening to events. Call on shutdown. */
	stop(): void {
		this.off();
	}

	/** Initialize a snapshot for a task. Returns the snapshot. */
	init(
		taskId: string,
		meta: Pick<WorkflowMeta, "name" | "description"> & { phases?: WorkflowMeta["phases"] },
	): WorkflowSnapshot {
		const snap = createWorkflowSnapshot(meta as WorkflowMeta);
		this.snapshots.set(taskId, snap);
		this.agentIdCounters.set(taskId, 0);
		return snap;
	}

	/** Get current snapshot for a task, or null if not initialized. */
	get(taskId: string): WorkflowSnapshot | null {
		return this.snapshots.get(taskId) ?? null;
	}

	/** Remove snapshot for a task (cleanup). */
	remove(taskId: string): void {
		this.snapshots.delete(taskId);
		this.agentIdCounters.delete(taskId);
	}

	private handleEvent(event: ServerEvent): void {
		const taskId = event.taskId;
		if (!taskId) return;
		const snap = this.snapshots.get(taskId);
		if (!snap) return;

		switch (event.type) {
			case "workflow.agent_started": {
				const data = event.data as { label: string; phase?: string; prompt: string };
				const counter = this.agentIdCounters.get(taskId) ?? 0;
				const id = counter + 1;
				this.agentIdCounters.set(taskId, id);
				snap.agents.push({
					id,
					label: data.label,
					phase: data.phase,
					prompt: data.prompt,
					status: "running",
				});
				const node = upsertGraphNode(
					snap,
					{
						id: agentNodeId(id),
						kind: "agent",
						label: data.label,
						phase: data.phase,
						status: "running",
						summary: preview(data.prompt, 120),
					},
					event.ts,
				);
				const phaseId = data.phase ? phaseNodeId(data.phase) : snap.graph.cursorNodeId;
				if (phaseId) addGraphEdge(snap, phaseId, node.id, undefined, "active", event.ts);
				snap.graph.cursorNodeId = node.id;
				Object.assign(snap, recomputeWorkflowSnapshot(snap));
				break;
			}
			case "workflow.agent_completed": {
				const data = event.data as { label: string; result: unknown };
				const agent = snap.agents.find((a) => a.label === data.label && a.status === "running");
				if (agent) {
					const node = findGraphNode(snap, agentNodeId(agent.id));
					if (data.result === null || data.result === undefined) {
						agent.status = "error";
						agent.error = "agent returned null";
						updateGraphNode(node, "error", "agent returned null", event.ts);
					} else {
						agent.status = "done";
						agent.resultPreview = preview(data.result);
						updateGraphNode(node, "done", agent.resultPreview, event.ts);
					}
					Object.assign(snap, recomputeWorkflowSnapshot(snap));
				}
				break;
			}
			case "workflow.phase": {
				const data = event.data as { phase: string };
				const previousPhase = snap.currentPhase;
				snap.currentPhase = data.phase;
				if (!snap.phases.includes(data.phase)) {
					snap.phases.push(data.phase);
				}
				if (previousPhase && previousPhase !== data.phase) {
					const previous = findGraphNode(snap, phaseNodeId(previousPhase));
					updateGraphNode(previous, "done", previous?.summary, event.ts);
				}
				const node = upsertGraphNode(
					snap,
					{ id: phaseNodeId(data.phase), kind: "phase", label: data.phase, status: "running" },
					event.ts,
				);
				if (previousPhase && previousPhase !== data.phase) {
					addGraphEdge(snap, phaseNodeId(previousPhase), node.id, undefined, "active", event.ts);
				}
				snap.graph.cursorNodeId = node.id;
				break;
			}
			case "task.needs_human": {
				const data = event.data as { requestId: string; request?: { title?: string; detail?: string } };
				const node = upsertGraphNode(
					snap,
					{
						id: humanNodeId(data.requestId),
						kind: "human",
						label: data.request?.title ?? "Human decision required",
						status: "warning",
						summary: data.request?.detail,
					},
					event.ts,
				);
				if (snap.graph.cursorNodeId)
					addGraphEdge(snap, snap.graph.cursorNodeId, node.id, "needs_human", "warning", event.ts);
				snap.graph.cursorNodeId = node.id;
				break;
			}
			case "task.human_resolved": {
				const data = event.data as { requestId: string };
				const node = findGraphNode(snap, humanNodeId(data.requestId));
				updateGraphNode(node, "done", "resolved", event.ts);
				break;
			}
			case "task.finished": {
				// Finalize any phase nodes still marked as running.
				for (const node of snap.graph.nodes) {
					if (node.kind === "phase" && node.status === "running") {
						updateGraphNode(node, "done", node.summary, event.ts);
					}
				}
				// Clear current-phase indicators so the snapshot does not
				// imply an active phase after terminal completion.
				snap.currentPhase = undefined;
				snap.graph.cursorNodeId = undefined;
				break;
			}
			case "task.failed":
			case "task.aborted": {
				const data = event.data as { error?: string };
				// Only mark the cursor node as error if it is still running.
				// A completed agent should not be retroactively changed to error.
				const cursorNode = snap.graph.cursorNodeId ? findGraphNode(snap, snap.graph.cursorNodeId) : undefined;
				if (cursorNode && cursorNode.status === "running") {
					updateGraphNode(cursorNode, "error", data.error ?? event.type, event.ts);
				}
				// Finalize any phase nodes still marked as running.
				for (const n of snap.graph.nodes) {
					if (n.kind === "phase" && n.status === "running") {
						updateGraphNode(n, "error", data.error ?? event.type, event.ts);
					}
				}
				// Clear current-phase indicators so the snapshot does not
				// imply an active phase after terminal completion.
				snap.currentPhase = undefined;
				snap.graph.cursorNodeId = undefined;
				break;
			}
			// Intentionally ignore workflow.log — high frequency, not needed for snapshot
		}
	}
}

function findGraphNode(snapshot: WorkflowSnapshot, id: string): WorkflowGraphNode | undefined {
	return snapshot.graph.nodes.find((node) => node.id === id);
}

function upsertGraphNode(
	snapshot: WorkflowSnapshot,
	input: Omit<WorkflowGraphNode, "createdAt" | "updatedAt">,
	now: number,
): WorkflowGraphNode {
	const existing = findGraphNode(snapshot, input.id);
	if (existing) {
		existing.kind = input.kind;
		existing.label = input.label;
		existing.status = input.status;
		existing.phase = input.phase;
		existing.summary = input.summary ?? existing.summary;
		existing.error = input.error;
		existing.updatedAt = now;
		return existing;
	}
	const node: WorkflowGraphNode = { ...input, createdAt: now, updatedAt: now };
	snapshot.graph.nodes.push(node);
	return node;
}

function updateGraphNode(
	node: WorkflowGraphNode | undefined,
	status: WorkflowGraphNodeStatus,
	summary: string | undefined,
	now: number,
): void {
	if (!node) return;
	node.status = status;
	if (summary) node.summary = summary;
	if (status === "error" && summary) node.error = summary;
	node.updatedAt = now;
}

function addGraphEdge(
	snapshot: WorkflowSnapshot,
	from: string,
	to: string,
	label: string | undefined,
	status: "planned" | "active" | "done" | "warning" | "error",
	now: number,
): void {
	if (from === to) return;
	const id = `edge:${from}->${to}${label ? `:${label}` : ""}`;
	const existing = snapshot.graph.edges.find((edge) => edge.id === id);
	if (existing) {
		existing.status = status;
		return;
	}
	snapshot.graph.edges.push({ id, from, to, label, status, createdAt: now });
}
