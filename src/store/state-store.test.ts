import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { StateStore } from "./state-store.ts";

describe("StateStore schedule migration", () => {
	it("adds schedule_run_id to an existing v2 task database", () => {
		const root = mkdtempSync(join(tmpdir(), "kanade-store-"));
		const dbPath = join(root, "state.db");
		const legacy = new Database(dbPath);
		legacy.exec(`
			CREATE TABLE tasks (
				id TEXT PRIMARY KEY,
				workflow_source TEXT NOT NULL,
				workflow_name TEXT,
				workflow_path TEXT NOT NULL,
				status TEXT NOT NULL,
				base_repo TEXT,
				base_branch TEXT NOT NULL DEFAULT 'main',
				cwd TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				finished_at INTEGER,
				error TEXT,
				options TEXT NOT NULL,
				result TEXT,
				usage TEXT
			);
			CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
			INSERT INTO meta (key, value, updated_at) VALUES ('schema_version', '2', 0);
		`);
		legacy.close();

		const store = new StateStore(dbPath);
		try {
			store.insertTask({
				id: "T-0001",
				workflow_source: "saved",
				workflow_name: "scheduled",
				workflow_path: join(root, "workflow.js"),
				status: "created",
				base_repo: null,
				base_branch: "main",
				cwd: root,
				created_at: 1,
				started_at: null,
				finished_at: null,
				error: null,
				options: "{}",
				result: null,
				schedule_run_id: "SR-test",
			});
			expect(store.getTaskByScheduleRun("SR-test")?.id).toBe("T-0001");
		} finally {
			store.close();
		}
	});
});
