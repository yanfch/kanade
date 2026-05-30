import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/index.ts";
import { HumanGate } from "../human/index.ts";
import { StateStore } from "../store/index.ts";
import { EventBus } from "./event-bus.ts";
import { TaskManager } from "./task-manager.ts";

const SIMPLE_SCRIPT = "export const meta = { name: 'demo', description: 'Demo' }\nreturn { ok: true }";

function setup() {
	const root = mkdtempSync(join(tmpdir(), "kanade-server-"));
	process.env.KANADE_DIR = root;
	const config = loadConfig();
	const store = new StateStore(config.paths.stateDb);
	const events = new EventBus();
	const humanGate = new HumanGate(store, { initialPollMs: 5 });
	const manager = new TaskManager(config, store, events, humanGate);
	return { config, store, events, manager };
}

describe("TaskManager — core", () => {
	it("runs an inline task to completion", async () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"));
			expect(JSON.parse(manager.get(task.task_id)?.result ?? "null")).toEqual({ ok: true });
		} finally {
			store.close();
		}
	});

	it("pauses for human input and resumes after respond", async () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({
				source: "inline",
				script:
					"export const meta = { name: 'human', description: 'Human' }\nreturn await request_human({ title: 'Approve?' })",
			});

			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("needs_human"));
			const pending = store.listPendingNeedsHuman()[0];
			expect(pending.task_id).toBe(task.task_id);

			manager.respond(task.task_id, pending.request_id, { decision: "approve" });

			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"));
			expect(JSON.parse(manager.get(task.task_id)?.result ?? "null")).toEqual({ decision: "approve" });
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — getScript", () => {
	it("returns the script content for a known task", () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			expect(manager.getScript(task.task_id)).toBe(SIMPLE_SCRIPT);
		} finally {
			store.close();
		}
	});

	it("returns null for an unknown task", () => {
		const { store, manager } = setup();
		try {
			expect(manager.getScript("T-9999")).toBeNull();
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — getJournal", () => {
	it("returns null for an unknown task", () => {
		const { store, manager } = setup();
		try {
			expect(manager.getJournal("T-9999")).toBeNull();
		} finally {
			store.close();
		}
	});

	it("returns empty arrays when journal does not exist yet", () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			// journal.db is created lazily; may not exist immediately after create()
			const entries = manager.getJournal(task.task_id);
			expect(entries).not.toBeNull();
			expect(Array.isArray(entries?.agents)).toBe(true);
			expect(Array.isArray(entries?.humans)).toBe(true);
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — getArtifacts", () => {
	it("returns null for an unknown task", () => {
		const { store, manager } = setup();
		try {
			expect(manager.getArtifacts("T-9999")).toBeNull();
		} finally {
			store.close();
		}
	});

	it("returns empty array when no artifacts directory exists", async () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"));
			expect(manager.getArtifacts(task.task_id)).toEqual([]);
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — rerun", () => {
	it("throws for an unknown task", () => {
		const { store, manager } = setup();
		try {
			expect(() => manager.rerun("T-9999")).toThrow("Task not found");
		} finally {
			store.close();
		}
	});

	it("creates a new task that runs to completion", async () => {
		const { store, manager } = setup();
		try {
			const original = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(manager.get(original.task_id)?.status).toBe("finished"));

			const rerun = manager.rerun(original.task_id);

			expect(rerun.task_id).not.toBe(original.task_id);
			expect(rerun.rerun_of).toBe(original.task_id);

			await vi.waitFor(() => expect(manager.get(rerun.task_id)?.status).toBe("finished"));
			expect(JSON.parse(manager.get(rerun.task_id)?.result ?? "null")).toEqual({ ok: true });
		} finally {
			store.close();
		}
	});

	it("copies the journal so cached agent results are reused", async () => {
		const { config, store, manager } = setup();
		try {
			const original = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(manager.get(original.task_id)?.status).toBe("finished"));

			const rerun = manager.rerun(original.task_id);
			// The copied journal.db should exist in the new run dir before the run starts
			const copiedJournal = join(config.paths.runsDir, rerun.task_id, "journal.db");
			expect(existsSync(copiedJournal)).toBe(true);

			await vi.waitFor(() => expect(manager.get(rerun.task_id)?.status).toBe("finished"));
		} finally {
			store.close();
		}
	});

	it("merges option overrides onto the original options", async () => {
		const { store, manager } = setup();
		try {
			const original = manager.create({ source: "inline", script: SIMPLE_SCRIPT, options: { concurrency: 4 } });
			await vi.waitFor(() => expect(manager.get(original.task_id)?.status).toBe("finished"));

			const rerun = manager.rerun(original.task_id, { options: { concurrency: 8 } });
			const rerunTask = manager.get(rerun.task_id);
			expect(JSON.parse(rerunTask?.options ?? "{}")).toMatchObject({ concurrency: 8 });

			await vi.waitFor(() => expect(manager.get(rerun.task_id)?.status).toBe("finished"));
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — create source:saved", () => {
	it("runs a saved workflow by name", async () => {
		const { store, manager } = setup();
		try {
			manager.putWorkflow("demo", SIMPLE_SCRIPT);
			const task = manager.create({ source: "saved", workflow_name: "demo" });
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"));
			expect(JSON.parse(manager.get(task.task_id)?.result ?? "null")).toEqual({ ok: true });
			expect(manager.get(task.task_id)?.workflow_source).toBe("saved");
			expect(manager.get(task.task_id)?.workflow_name).toBe("demo");
		} finally {
			store.close();
		}
	});

	it("throws for an unknown workflow", () => {
		const { store, manager } = setup();
		try {
			expect(() => manager.create({ source: "saved", workflow_name: "missing" })).toThrow("Workflow not found");
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — workflow delegation", () => {
	it("listWorkflows returns empty array initially", () => {
		const { store, manager } = setup();
		try {
			expect(manager.listWorkflows()).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("putWorkflow / getWorkflow / deleteWorkflow round-trip", () => {
		const { store, manager } = setup();
		try {
			manager.putWorkflow("demo", SIMPLE_SCRIPT);
			expect(manager.getWorkflow("demo")?.name).toBe("demo");
			expect(manager.deleteWorkflow("demo")).toBe(true);
			expect(manager.getWorkflow("demo")).toBeNull();
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — save", () => {
	it("throws for an unknown task", () => {
		const { store, manager } = setup();
		try {
			expect(() => manager.save("T-9999", "my-workflow")).toThrow("Task not found");
		} finally {
			store.close();
		}
	});

	it("throws for an invalid name", () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			expect(() => manager.save(task.task_id, "bad name!")).toThrow();
			expect(() => manager.save(task.task_id, "")).toThrow();
			expect(() => manager.save(task.task_id, "../escape")).toThrow();
		} finally {
			store.close();
		}
	});

	it("writes the script to workflowsDir/<name>.js", async () => {
		const { config, store, manager } = setup();
		try {
			const task = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"));

			manager.save(task.task_id, "my-workflow");

			const dest = join(config.paths.workflowsDir, "my-workflow.js");
			expect(existsSync(dest)).toBe(true);
			expect(readFileSync(dest, "utf8")).toBe(SIMPLE_SCRIPT);
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — create source:generated", () => {
	it("generates a script, writes it to workflow.js, and runs to completion", async () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({
				source: "generated",
				prompt: "return { generated: true }",
			});
			expect(task.generated).toBe(true);
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).not.toBe("created"), {
				timeout: 5000,
			});
			// workflow.js must exist immediately after script generation
			expect(existsSync(task.workflow_path)).toBe(true);
		} finally {
			store.close();
		}
	});

	it("emits task.script_generated before task.running", async () => {
		const { store, events, manager } = setup();
		try {
			const emitted: string[] = [];
			events.onAny((e) => emitted.push(e.type));

			const task = manager.create({ source: "generated", prompt: "return {}" });
			await vi.waitFor(() => expect(emitted).toContain("task.script_generated"), { timeout: 5000 });

			const scriptIdx = emitted.indexOf("task.script_generated");
			const runningIdx = emitted.indexOf("task.running");
			if (runningIdx !== -1) expect(scriptIdx).toBeLessThan(runningIdx);

			manager.abort(task.task_id);
		} finally {
			store.close();
		}
	});

	it("uses injected author to avoid real LLM calls in tests", async () => {
		const { store, manager } = setup();
		try {
			// The default author is a stub that echoes the prompt as a minimal script.
			// Real LLM author is only used when pi SDK is configured.
			const task = manager.create({ source: "generated", prompt: "return { ok: true }" });
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"), {
				timeout: 5000,
			});
			expect(JSON.parse(manager.get(task.task_id)?.result ?? "null")).toMatchObject({ ok: true });
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — abort", () => {
	it("sets status to aborted and emits task.aborted", async () => {
		const { store, events, manager } = setup();
		try {
			const emitted: string[] = [];
			events.onAny((e) => emitted.push(e.type));

			const task = manager.create({
				source: "inline",
				script:
					"export const meta = { name: 'slow', description: 'Slow' }\nreturn await request_human({ title: 'wait' })",
			});
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("needs_human"));

			manager.abort(task.task_id);

			expect(manager.get(task.task_id)?.status).toBe("aborted");
			expect(manager.get(task.task_id)?.finished_at).toBeTruthy();
			expect(emitted).toContain("task.aborted");
		} finally {
			store.close();
		}
	});

	it("abort is idempotent for unknown tasks", () => {
		const { store, manager } = setup();
		try {
			// Should not throw
			manager.abort("T-9999");
		} finally {
			store.close();
		}
	});

	it("abort while task is running propagates signal", async () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({
				source: "inline",
				script:
					"export const meta = { name: 'human', description: 'Human' }\nreturn await request_human({ title: 'Approve?' })",
			});
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("needs_human"));

			manager.abort(task.task_id);

			// Task should eventually be aborted (abort() sets it immediately,
			// and the run() catch also processes it)
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("aborted"));
			expect(manager.get(task.task_id)?.finished_at).toBeTruthy();
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — task failure", () => {
	it("sets status to failed when script throws", async () => {
		const { store, events, manager } = setup();
		try {
			const emitted: string[] = [];
			events.onAny((e) => emitted.push(e.type));

			const task = manager.create({
				source: "inline",
				script: "export const meta = { name: 'fail', description: 'Fail' }\nthrow new Error('intentional failure')",
			});

			await vi.waitFor(() => {
				const t = manager.get(task.task_id);
				expect(t?.status).toBe("failed");
			});

			expect(manager.get(task.task_id)?.error).toContain("intentional failure");
			expect(manager.get(task.task_id)?.finished_at).toBeTruthy();
			expect(emitted).toContain("task.failed");
		} finally {
			store.close();
		}
	});

	it("sets status to failed when script has syntax error", async () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({
				source: "inline",
				script: "export const meta = { name: 'bad', description: 'Bad' }\n{{{invalid syntax!!!",
			});

			await vi.waitFor(() => {
				const t = manager.get(task.task_id);
				expect(t?.status).toBe("failed");
			});

			expect(manager.get(task.task_id)?.error).toBeTruthy();
		} finally {
			store.close();
		}
	});

	it("sets status to failed when script has no meta export", async () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({
				source: "inline",
				script: "return { ok: true }",
			});

			await vi.waitFor(() => {
				const t = manager.get(task.task_id);
				expect(t?.status).toBe("failed");
			});

			expect(manager.get(task.task_id)?.error).toContain("meta");
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — lifecycle events", () => {
	it("emits task.created then task.running then task.finished in order", async () => {
		const { store, events, manager } = setup();
		try {
			const emitted: string[] = [];
			events.onAny((e) => emitted.push(e.type));

			const task = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"));

			const createdIdx = emitted.indexOf("task.created");
			const runningIdx = emitted.indexOf("task.running");
			const finishedIdx = emitted.indexOf("task.finished");

			expect(createdIdx).toBeGreaterThanOrEqual(0);
			expect(runningIdx).toBeGreaterThan(createdIdx);
			expect(finishedIdx).toBeGreaterThan(runningIdx);
		} finally {
			store.close();
		}
	});

	it("emits workflow.phase events during execution", async () => {
		const { store, events, manager } = setup();
		try {
			const phases: string[] = [];
			events.onAny((e) => {
				if (e.type === "workflow.phase") phases.push((e.data as { phase: string }).phase);
			});

			const script = `
				export const meta = { name: 'phased', description: 'Phased', phases: [{ title: 'Build' }] }
				phase('Build')
				return { done: true }
			`;
			const task = manager.create({ source: "inline", script });
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"));

			expect(phases).toContain("Build");
		} finally {
			store.close();
		}
	});

	it("emits workflow.log events", async () => {
		const { store, events, manager } = setup();
		try {
			const logs: string[] = [];
			events.onAny((e) => {
				if (e.type === "workflow.log") logs.push((e.data as { message: string }).message);
			});

			const script = `
				export const meta = { name: 'logger', description: 'Logger' }
				log('hello from workflow')
				return { done: true }
			`;
			const task = manager.create({ source: "inline", script });
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"));

			expect(logs).toContain("hello from workflow");
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — journal persistence", () => {
	it("creates journal.db after task completes", async () => {
		const { config, store, manager } = setup();
		try {
			const task = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"));

			const journalPath = join(config.paths.runsDir, task.task_id, "journal.db");
			expect(existsSync(journalPath)).toBe(true);

			// getJournal should return entries
			const entries = manager.getJournal(task.task_id);
			expect(entries).not.toBeNull();
		} finally {
			store.close();
		}
	});

	it("getJournal returns null for a task that never ran", () => {
		const { store, manager } = setup();
		try {
			expect(manager.getJournal("T-9999")).toBeNull();
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — generated workflow failure", () => {
	it("sets status to failed when author.generate() throws", async () => {
		const { store, events, manager: _manager } = setup();
		try {
			const emitted: string[] = [];
			events.onAny((e) => emitted.push(e.type));

			// Inject an author that always fails
			const failManager = new (await import("./task-manager.ts")).TaskManager(
				(await import("../config/index.ts")).loadConfig(),
				store,
				events,
				new (await import("../human/index.ts")).HumanGate(store, { initialPollMs: 5 }),
				{
					async generate() {
						throw new Error("LLM unavailable");
					},
				},
			);

			const task = failManager.create({ source: "generated", prompt: "test" });
			expect(task.generated).toBe(true);

			await vi.waitFor(() => {
				const t = failManager.get(task.task_id);
				expect(t?.status).toBe("failed");
			});

			expect(failManager.get(task.task_id)?.error).toContain("LLM unavailable");
			expect(emitted).toContain("task.failed");
		} finally {
			store.close();
		}
	});

	it("emits task.script_generated before run starts for successful generation", async () => {
		const { store, events, manager } = setup();
		try {
			const emitted: Array<{ type: string; data: unknown }> = [];
			events.onAny((e) => emitted.push({ type: e.type, data: e.data }));

			const task = manager.create({ source: "generated", prompt: "return { ok: true }" });
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"), {
				timeout: 5000,
			});

			const scriptGenIdx = emitted.findIndex((e) => e.type === "task.script_generated");
			const runningIdx = emitted.findIndex((e) => e.type === "task.running");
			expect(scriptGenIdx).toBeGreaterThanOrEqual(0);
			expect(runningIdx).toBeGreaterThan(scriptGenIdx);
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — task metadata", () => {
	it("stores base_branch from config in task row", async () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			const row = manager.get(task.task_id);
			expect(row?.base_branch).toBe("develop");
			expect(row?.workflow_source).toBe("inline");
			expect(row?.created_at).toBeTruthy();
		} finally {
			store.close();
		}
	});

	it("stores options as JSON string", async () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({
				source: "inline",
				script: SIMPLE_SCRIPT,
				options: { concurrency: 4, model: "test-model" },
			});
			const row = manager.get(task.task_id);
			const opts = JSON.parse(row?.options ?? "{}");
			expect(opts.concurrency).toBe(4);
			expect(opts.model).toBe("test-model");
		} finally {
			store.close();
		}
	});
});

describe("TaskManager — list", () => {
	it("lists all tasks", async () => {
		const { store, manager } = setup();
		try {
			manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => {
				const all = manager.list();
				expect(all.length).toBeGreaterThanOrEqual(2);
			});
		} finally {
			store.close();
		}
	});

	it("filters tasks by status", async () => {
		const { store, manager } = setup();
		try {
			const task = manager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(manager.get(task.task_id)?.status).toBe("finished"));

			const finished = manager.list("finished");
			expect(finished.some((t) => t.id === task.task_id)).toBe(true);

			const running = manager.list("running");
			expect(running.some((t) => t.id === task.task_id)).toBe(false);
		} finally {
			store.close();
		}
	});
});
