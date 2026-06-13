import { describe, expect, it } from "vitest";
import { EventBus } from "../server/event-bus.ts";
import { SnapshotBuilder } from "./snapshot-builder.ts";

describe("SnapshotBuilder", () => {
	it("creates initial snapshot from meta", () => {
		const events = new EventBus();
		const builder = new SnapshotBuilder(events);

		const snap = builder.init("T-0001", { name: "test", description: "A test workflow" });
		expect(snap.name).toBe("test");
		expect(snap.description).toBe("A test workflow");
		expect(snap.agents).toEqual([]);
		expect(snap.agentCount).toBe(0);
		expect(snap.graph.nodes).toEqual([]);
	});

	it("seeds planned graph nodes from meta phases", () => {
		const events = new EventBus();
		const builder = new SnapshotBuilder(events);

		const snap = builder.init("T-0001", {
			name: "test",
			description: "A test workflow",
			phases: [{ title: "Analyze" }, { title: "Implement" }, { title: "Review" }],
		});

		expect(snap.graph.nodes.map((node) => [node.id, node.status])).toEqual([
			["phase:analyze", "planned"],
			["phase:implement", "planned"],
			["phase:review", "planned"],
		]);
		expect(snap.graph.edges.map((edge) => [edge.from, edge.to, edge.status])).toEqual([
			["phase:analyze", "phase:implement", "planned"],
			["phase:implement", "phase:review", "planned"],
		]);
	});

	it("adds agent on workflow.agent_started event", () => {
		const events = new EventBus();
		const builder = new SnapshotBuilder(events);
		builder.init("T-0001", { name: "test", description: "" });

		events.emit(
			"workflow.agent_started",
			{ taskId: "T-0001", label: "researcher", phase: "scan", prompt: "do it" },
			"T-0001",
		);

		const snap = builder.get("T-0001")!;
		expect(snap.agents).toHaveLength(1);
		expect(snap.agents[0].label).toBe("researcher");
		expect(snap.agents[0].status).toBe("running");
		expect(snap.agents[0].phase).toBe("scan");
		expect(snap.agentCount).toBe(1);
		expect(snap.runningCount).toBe(1);
		expect(snap.graph.nodes).toContainEqual(
			expect.objectContaining({ id: "agent:1", kind: "agent", label: "researcher", status: "running" }),
		);
		expect(snap.graph.cursorNodeId).toBe("agent:1");
	});

	it("marks agent done on workflow.agent_completed with result", () => {
		const events = new EventBus();
		const builder = new SnapshotBuilder(events);
		builder.init("T-0001", { name: "test", description: "" });

		events.emit("workflow.agent_started", { taskId: "T-0001", label: "a", prompt: "p" }, "T-0001");
		events.emit("workflow.agent_completed", { taskId: "T-0001", label: "a", result: { answer: 42 } }, "T-0001");

		const snap = builder.get("T-0001")!;
		expect(snap.agents[0].status).toBe("done");
		expect(snap.agents[0].resultPreview).toContain("42");
		expect(snap.runningCount).toBe(0);
		expect(snap.doneCount).toBe(1);
		expect(snap.graph.nodes.find((node) => node.id === "agent:1")?.status).toBe("done");
	});

	it("marks agent error on workflow.agent_completed with null result", () => {
		const events = new EventBus();
		const builder = new SnapshotBuilder(events);
		builder.init("T-0001", { name: "test", description: "" });

		events.emit("workflow.agent_started", { taskId: "T-0001", label: "a", prompt: "p" }, "T-0001");
		events.emit("workflow.agent_completed", { taskId: "T-0001", label: "a", result: null }, "T-0001");

		const snap = builder.get("T-0001")!;
		expect(snap.agents[0].status).toBe("error");
		expect(snap.errorCount).toBe(1);
	});

	it("updates currentPhase on workflow.phase event", () => {
		const events = new EventBus();
		const builder = new SnapshotBuilder(events);
		builder.init("T-0001", { name: "test", description: "" });

		events.emit("workflow.phase", { taskId: "T-0001", phase: "Research" }, "T-0001");

		const snap = builder.get("T-0001")!;
		expect(snap.currentPhase).toBe("Research");
		expect(snap.phases).toContain("Research");
		expect(snap.graph.nodes).toContainEqual(
			expect.objectContaining({ id: "phase:research", kind: "phase", label: "Research", status: "running" }),
		);
		expect(snap.graph.cursorNodeId).toBe("phase:research");
	});

	it("adds warning human gate nodes and marks them resolved", () => {
		const events = new EventBus();
		const builder = new SnapshotBuilder(events);
		builder.init("T-0001", { name: "test", description: "" });

		events.emit("workflow.phase", { taskId: "T-0001", phase: "Review" }, "T-0001");
		events.emit(
			"task.needs_human",
			{ taskId: "T-0001", requestId: "R-1", request: { title: "Approve merge?" } },
			"T-0001",
		);

		let snap = builder.get("T-0001")!;
		expect(snap.graph.nodes).toContainEqual(
			expect.objectContaining({ id: "human:r-1", kind: "human", label: "Approve merge?", status: "warning" }),
		);
		expect(snap.graph.edges).toContainEqual(
			expect.objectContaining({ from: "phase:review", to: "human:r-1", label: "needs_human", status: "warning" }),
		);

		events.emit(
			"task.human_resolved",
			{ taskId: "T-0001", requestId: "R-1", response: { decision: "approve" } },
			"T-0001",
		);
		snap = builder.get("T-0001")!;
		expect(snap.graph.nodes.find((node) => node.id === "human:r-1")?.status).toBe("done");
	});

	it("tracks multiple agents with different statuses", () => {
		const events = new EventBus();
		const builder = new SnapshotBuilder(events);
		builder.init("T-0001", { name: "test", description: "" });

		events.emit("workflow.agent_started", { taskId: "T-0001", label: "a", prompt: "p" }, "T-0001");
		events.emit("workflow.agent_started", { taskId: "T-0001", label: "b", prompt: "p" }, "T-0001");
		events.emit("workflow.agent_completed", { taskId: "T-0001", label: "a", result: "ok" }, "T-0001");

		const snap = builder.get("T-0001")!;
		expect(snap.agents).toHaveLength(2);
		expect(snap.agents[0].status).toBe("done");
		expect(snap.agents[1].status).toBe("running");
		expect(snap.runningCount).toBe(1);
		expect(snap.doneCount).toBe(1);
	});

	it("ignores events for unknown taskId", () => {
		const events = new EventBus();
		const builder = new SnapshotBuilder(events);

		// No init for T-0001
		events.emit("workflow.agent_started", { taskId: "T-0001", label: "a", prompt: "p" }, "T-0001");

		expect(builder.get("T-0001")).toBeNull();
	});

	it("ignores events for different taskId", () => {
		const events = new EventBus();
		const builder = new SnapshotBuilder(events);
		builder.init("T-0001", { name: "test", description: "" });

		events.emit("workflow.agent_started", { taskId: "T-0002", label: "a", prompt: "p" }, "T-0002");

		expect(builder.get("T-0001")!.agents).toHaveLength(0);
	});

	it("get() returns null for unknown taskId", () => {
		const events = new EventBus();
		const builder = new SnapshotBuilder(events);
		expect(builder.get("T-9999")).toBeNull();
	});

	it("remove() cleans up snapshot", () => {
		const events = new EventBus();
		const builder = new SnapshotBuilder(events);
		builder.init("T-0001", { name: "test", description: "" });
		expect(builder.get("T-0001")).not.toBeNull();

		builder.remove("T-0001");
		expect(builder.get("T-0001")).toBeNull();
	});
});
