import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type NeedsHumanRow, StateStore, type TaskRow } from "../store/index.ts";
import { HumanGate } from "./index.ts";

function createStore(): StateStore {
	const dir = mkdtempSync(join(tmpdir(), "kanade-human-"));
	const store = new StateStore(join(dir, "state.db"));
	store.insertTask(createTask());
	return store;
}

function createTask(): TaskRow {
	return {
		id: "T-1",
		workflow_source: "inline",
		workflow_name: null,
		workflow_path: "/tmp/workflow.js",
		status: "needs_human",
		base_repo: null,
		base_branch: "develop",
		cwd: "/repo",
		created_at: Date.now(),
		started_at: null,
		finished_at: null,
		error: null,
		options: "{}",
		result: null,
	};
}

function insertPending(store: StateStore, requestId = "req-1"): NeedsHumanRow {
	const row: NeedsHumanRow = {
		request_id: requestId,
		task_id: "T-1",
		cache_key: "cache-key",
		payload: JSON.stringify({ title: "Approve?" }),
		status: "pending",
		created_at: Date.now(),
		resolved_at: null,
		response: null,
	};
	store.insertNeedsHuman(row);
	return row;
}

describe("HumanGate", () => {
	it("resolves active waiters immediately", async () => {
		const store = createStore();
		try {
			insertPending(store);
			const gate = new HumanGate(store, { initialPollMs: 10 });

			const waiting = gate.wait("req-1");
			gate.resolve("req-1", { decision: "approve" });

			await expect(waiting).resolves.toEqual({ decision: "approve" });
			expect(store.getNeedsHuman("req-1")?.status).toBe("resolved");
		} finally {
			store.close();
		}
	});

	it("returns already resolved responses without waiting", async () => {
		const store = createStore();
		try {
			insertPending(store);
			store.updateNeedsHuman("req-1", {
				status: "resolved",
				resolved_at: Date.now(),
				response: JSON.stringify({ freeform: "done" }),
			});
			const gate = new HumanGate(store, { initialPollMs: 10 });

			await expect(gate.wait("req-1")).resolves.toEqual({ freeform: "done" });
		} finally {
			store.close();
		}
	});

	it("polls the store as a fallback", async () => {
		const store = createStore();
		try {
			insertPending(store);
			const gate = new HumanGate(store, { initialPollMs: 5 });
			const waiting = gate.wait("req-1");

			setTimeout(() => {
				store.updateNeedsHuman("req-1", {
					status: "resolved",
					resolved_at: Date.now(),
					response: JSON.stringify({ decision: "poll" }),
				});
			}, 10);

			await expect(waiting).resolves.toEqual({ decision: "poll" });
		} finally {
			store.close();
		}
	});

	it("rejects when aborted", async () => {
		const store = createStore();
		try {
			insertPending(store);
			const gate = new HumanGate(store, { initialPollMs: 10 });
			const controller = new AbortController();
			const waiting = gate.wait("req-1", controller.signal);

			controller.abort();

			await expect(waiting).rejects.toThrow(/aborted/);
		} finally {
			store.close();
		}
	});

	it("rejects invalid resolve calls", () => {
		const store = createStore();
		try {
			const gate = new HumanGate(store);
			expect(() => gate.resolve("missing", { decision: "approve" })).toThrow(/not found/);

			insertPending(store);
			gate.resolve("req-1", { decision: "approve" });
			expect(() => gate.resolve("req-1", { decision: "approve" })).toThrow(/not pending/);
		} finally {
			store.close();
		}
	});
});
