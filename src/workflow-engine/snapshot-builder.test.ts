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
