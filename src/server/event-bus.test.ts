import { describe, expect, it } from "vitest";
import { EventBus } from "./event-bus.ts";

describe("EventBus", () => {
	it("emits events with a stable incrementing id", () => {
		const bus = new EventBus();
		const e1 = bus.emit("a", { x: 1 }, "T-1");
		const e2 = bus.emit("b", { x: 2 }, "T-1");
		const e3 = bus.emit("c", { x: 3 }, "T-2");

		expect(e1.id).toBe(1);
		expect(e2.id).toBe(2);
		expect(e3.id).toBe(3);
		expect(e2.id).toBeGreaterThan(e1.id);
	});

	it("stores recent events per task", () => {
		const bus = new EventBus();
		bus.emit("step1", { ok: true }, "T-1");
		bus.emit("step2", { ok: true }, "T-1");
		bus.emit("other", { ok: true }, "T-2");

		const t1Events = bus.getTaskEvents("T-1");
		expect(t1Events).toHaveLength(2);
		expect(t1Events[0].type).toBe("step1");
		expect(t1Events[1].type).toBe("step2");

		const t2Events = bus.getTaskEvents("T-2");
		expect(t2Events).toHaveLength(1);
		expect(t2Events[0].type).toBe("other");
	});

	it("returns empty array for unknown task", () => {
		const bus = new EventBus();
		expect(bus.getTaskEvents("unknown")).toEqual([]);
	});

	it("keeps only the recent per-task events", () => {
		const bus = new EventBus(2);
		bus.emit("old", {}, "T-1");
		bus.emit("middle", {}, "T-1");
		bus.emit("new", {}, "T-1");

		expect(bus.getTaskEvents("T-1").map((e) => e.type)).toEqual(["middle", "new"]);
	});

	it("replay returns stored events and then streams live events", async () => {
		const bus = new EventBus();
		// Pre-emit some events
		bus.emit("past1", { v: 1 }, "T-1");
		bus.emit("past2", { v: 2 }, "T-1");

		const received: Array<{ id: number; type: string }> = [];

		// Use replayAndSubscribe — returns past events synchronously and unsub function
		const { past, unsubscribe } = bus.replayAndSubscribe("T-1", (event) => {
			received.push({ id: event.id, type: event.type });
		});

		expect(past).toHaveLength(2);
		expect(past[0].type).toBe("past1");
		expect(past[1].type).toBe("past2");

		// Emit a live event
		const live = bus.emit("live1", { v: 3 }, "T-1");
		expect(received).toHaveLength(1);
		expect(received[0].type).toBe("live1");
		expect(received[0].id).toBe(live.id);

		unsubscribe();
	});

	it("events from other tasks do not appear in replay stream", () => {
		const bus = new EventBus();
		bus.emit("for-t1", {}, "T-1");

		const received: string[] = [];
		const { past, unsubscribe } = bus.replayAndSubscribe("T-2", (e) => received.push(e.type));

		expect(past).toHaveLength(0);

		bus.emit("for-t1-again", {}, "T-1");
		bus.emit("for-t2", {}, "T-2");
		expect(received).toEqual(["for-t2"]);

		unsubscribe();
	});
});
