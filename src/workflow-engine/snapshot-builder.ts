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
import { type WorkflowSnapshot, createWorkflowSnapshot, preview, recomputeWorkflowSnapshot } from "./snapshot.ts";

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
				Object.assign(snap, recomputeWorkflowSnapshot(snap));
				break;
			}
			case "workflow.agent_completed": {
				const data = event.data as { label: string; result: unknown };
				const agent = snap.agents.find((a) => a.label === data.label && a.status === "running");
				if (agent) {
					if (data.result === null || data.result === undefined) {
						agent.status = "error";
						agent.error = "agent returned null";
					} else {
						agent.status = "done";
						agent.resultPreview = preview(data.result);
					}
					Object.assign(snap, recomputeWorkflowSnapshot(snap));
				}
				break;
			}
			case "workflow.phase": {
				const data = event.data as { phase: string };
				snap.currentPhase = data.phase;
				if (!snap.phases.includes(data.phase)) {
					snap.phases.push(data.phase);
				}
				break;
			}
			// Intentionally ignore workflow.log — high frequency, not needed for snapshot
		}
	}
}
