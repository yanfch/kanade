import { describe, expect, it, vi } from "vitest";
import { AnnouncerRegistry, renderTemplate } from "./announcer.ts";
import type { ServerEvent } from "./event-bus.ts";

function fakeEvent(overrides: Partial<ServerEvent> = {}): ServerEvent {
	return {
		id: 1,
		type: "task.finished",
		ts: Date.now(),
		taskId: "T-0001",
		data: { taskId: "T-0001", result: { answer: 42 } },
		...overrides,
	};
}

describe("renderTemplate", () => {
	it("replaces {{task.id}} with taskId", () => {
		const result = renderTemplate("Task {{task.id}} done", fakeEvent());
		expect(result).toBe("Task T-0001 done");
	});

	it("replaces {{event.type}} with event type", () => {
		const result = renderTemplate("Event: {{event.type}}", fakeEvent());
		expect(result).toBe("Event: task.finished");
	});

	it("replaces {{event.summary}} with auto-generated summary", () => {
		const result = renderTemplate("{{event.summary}}", fakeEvent({ data: { taskId: "T-0001", result: { ok: true } } }));
		expect(result).toContain("finished");
	});

	it("handles missing variables gracefully", () => {
		const result = renderTemplate("{{unknown.var}}", fakeEvent());
		expect(result).toBe("");
	});

	it("replaces multiple variables", () => {
		const result = renderTemplate("{{task.id}}: {{event.type}}", fakeEvent());
		expect(result).toBe("T-0001: task.finished");
	});
});

describe("AnnouncerRegistry", () => {
	it("returns empty result when no announcers configured", async () => {
		const registry = new AnnouncerRegistry([]);
		const result = await registry.dispatch(fakeEvent());
		expect(result.dispatched).toBe(false);
	});

	it("skips disabled announcers", async () => {
		const handler = vi.fn().mockResolvedValue(true);
		const registry = new AnnouncerRegistry([
			{ name: "test", type: "http_post", url: "http://localhost/test", events: ["task.finished"], enabled: false },
		]);
		registry.registerHandler("http_post", handler);

		await registry.dispatch(fakeEvent());
		expect(handler).not.toHaveBeenCalled();
	});

	it("filters events by type", async () => {
		const handler = vi.fn().mockResolvedValue(true);
		const registry = new AnnouncerRegistry([
			{ name: "test", type: "http_post", url: "http://localhost/test", events: ["task.needs_human"], enabled: true },
		]);
		registry.registerHandler("http_post", handler);

		// task.finished should NOT match task.needs_human filter
		await registry.dispatch(fakeEvent({ type: "task.finished" }));
		expect(handler).not.toHaveBeenCalled();

		// task.needs_human should match
		await registry.dispatch(fakeEvent({ type: "task.needs_human" }));
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("calls handler with rendered body", async () => {
		const handler = vi.fn().mockResolvedValue(true);
		const registry = new AnnouncerRegistry([
			{
				name: "test",
				type: "http_post",
				url: "http://localhost/test",
				events: ["task.finished"],
				body_template: "{{task.id}}: {{event.type}}",
				enabled: true,
			},
		]);
		registry.registerHandler("http_post", handler);

		await registry.dispatch(fakeEvent());
		expect(handler).toHaveBeenCalledWith(
			expect.objectContaining({
				renderedBody: "T-0001: task.finished",
			}),
		);
	});

	it("uses fallback when primary fails", async () => {
		const primary = vi.fn().mockResolvedValue(false); // failed
		const fallback = vi.fn().mockResolvedValue(true);
		const registry = new AnnouncerRegistry([
			{
				name: "primary",
				type: "http_post",
				url: "http://localhost/p",
				events: ["task.finished"],
				enabled: true,
				fallback: "backup",
			},
			{ name: "backup", type: "macos_notification", events: ["task.finished"], enabled: true },
		]);
		registry.registerHandler("http_post", primary);
		registry.registerHandler("macos_notification", fallback);

		const result = await registry.dispatch(fakeEvent());
		expect(primary).toHaveBeenCalledTimes(1);
		expect(fallback).toHaveBeenCalledTimes(1);
		expect(result.announcer).toBe("backup");
	});

	it("stops at first success in fallback chain", async () => {
		const primary = vi.fn().mockResolvedValue(false);
		const secondary = vi.fn().mockResolvedValue(true);
		const tertiary = vi.fn().mockResolvedValue(true);
		const registry = new AnnouncerRegistry([
			{ name: "a", type: "http_post", url: "", events: ["task.finished"], enabled: true, fallback: "b" },
			{ name: "b", type: "http_post", url: "", events: ["task.finished"], enabled: true, fallback: "c" },
			{ name: "c", type: "http_post", url: "", events: ["task.finished"], enabled: true },
		]);
		registry.registerHandler("http_post", async (ctx) => {
			if (ctx.config.name === "a") return primary(ctx);
			if (ctx.config.name === "b") return secondary(ctx);
			return tertiary(ctx);
		});

		const result = await registry.dispatch(fakeEvent());
		expect(primary).toHaveBeenCalled();
		expect(secondary).toHaveBeenCalled();
		expect(tertiary).not.toHaveBeenCalled();
		expect(result.announcer).toBe("b");
	});

	it("handler throwing error is treated as failure and triggers fallback", async () => {
		const primary = vi.fn().mockRejectedValue(new Error("network error"));
		const fallback = vi.fn().mockResolvedValue(true);
		const registry = new AnnouncerRegistry([
			{ name: "flaky", type: "http_post", url: "", events: ["task.finished"], enabled: true, fallback: "safe" },
			{ name: "safe", type: "macos_notification", events: ["task.finished"], enabled: true },
		]);
		registry.registerHandler("http_post", primary);
		registry.registerHandler("macos_notification", fallback);

		const result = await registry.dispatch(fakeEvent());
		expect(result.announcer).toBe("safe");
	});

	it("dispatch returns dispatched=false when all announcers filtered out", async () => {
		const handler = vi.fn().mockResolvedValue(true);
		const registry = new AnnouncerRegistry([
			{ name: "test", type: "http_post", url: "", events: ["task.aborted"], enabled: true },
		]);
		registry.registerHandler("http_post", handler);

		const result = await registry.dispatch(fakeEvent({ type: "task.finished" }));
		expect(result.dispatched).toBe(false);
		expect(handler).not.toHaveBeenCalled();
	});

	it("probe() checks http_post announcers with auto enabled", async () => {
		const probe = vi.fn().mockResolvedValue(true);
		const registry = new AnnouncerRegistry([
			{ name: "auto", type: "http_post", url: "http://localhost/health", events: ["task.finished"], enabled: "auto" },
			{ name: "manual", type: "http_post", url: "http://localhost/other", events: ["task.finished"], enabled: true },
		]);
		registry.registerProbe(probe);

		await registry.probe();
		expect(probe).toHaveBeenCalledWith(expect.objectContaining({ name: "auto" }));
		expect(probe).not.toHaveBeenCalledWith(expect.objectContaining({ name: "manual" }));
	});

	it("probe() disables announcer when health check fails", async () => {
		const probe = vi.fn().mockResolvedValue(false);
		const handler = vi.fn().mockResolvedValue(true);
		const registry = new AnnouncerRegistry([
			{ name: "flaky", type: "http_post", url: "http://localhost/down", events: ["task.finished"], enabled: "auto" },
		]);
		registry.registerProbe(probe);
		registry.registerHandler("http_post", handler);

		await registry.probe();
		await registry.dispatch(fakeEvent());
		expect(handler).not.toHaveBeenCalled();
	});
});
