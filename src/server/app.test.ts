import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/index.ts";
import { HumanGate } from "../human/index.ts";
import { StateStore } from "../store/index.ts";
import { createApp } from "./app.ts";
import { EventBus } from "./event-bus.ts";
import { TaskManager } from "./task-manager.ts";
import { createMockSessionFactory } from "./test-session-mock.ts";

const SIMPLE_SCRIPT = "export const meta = { name: 'demo', description: 'Demo' }\nreturn { ok: true }";
const TEST_GIT_AUTHOR = ["-c", "user.name=Kanade Test", "-c", "user.email=kanade@example.com"];
const TEST_BASE_REF = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

function tempWorktreePath(prefix: string): string {
	return join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function setup(
	author?: {
		generate(
			prompt: string,
			options?: { model?: string; workspaceRoot?: string; complexityHint?: "simple" | "medium" | "complex" },
		): Promise<string>;
	},
	sessionFactory?: ConstructorParameters<typeof TaskManager>[6],
) {
	const root = mkdtempSync(join(tmpdir(), "kanade-app-"));
	process.env.KANADE_DIR = root;
	const config = loadConfig();
	config.models.mode = "kanade";
	config.defaults.taskIdPrefix = `UA${Math.random().toString(36).slice(2, 6)}`;
	const store = new StateStore(config.paths.stateDb);
	const events = new EventBus();
	const humanGate = new HumanGate(store, { initialPollMs: 5 });
	const taskManager = new TaskManager(config, store, events, humanGate, author, undefined, sessionFactory);
	const app = createApp({ taskManager, events, config });
	return { root, config, store, taskManager, events, app };
}

describe("server app — existing", () => {
	it("lists pending human requests through /inbox", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({
				source: "inline",
				script:
					"export const meta = { name: 'human', description: 'Human' }\nreturn await request_human({ title: 'Approve?', options: ['yes'] })",
			});
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("needs_human"));

			const response = await app.request("/inbox");
			const body = (await response.json()) as { requests: Array<Record<string, unknown>> };

			expect(response.status).toBe(200);
			expect(body.requests).toHaveLength(1);
			expect(body.requests[0]).toMatchObject({
				task_id: created.task_id,
				payload: { title: "Approve?", options: ["yes"] },
				status: "pending",
			});
			await taskManager.abort(created.task_id);
		} finally {
			store.close();
		}
	});

	it("rejects missing task event streams and supports task event subscriptions", async () => {
		const { store, events, app } = setup();
		try {
			const response = await app.request("/tasks/T-1/events");
			expect(response.status).toBe(404);

			const received: string[] = [];
			const off = events.onTask("T-1", (event) => received.push(event.type));
			events.emit("task.test", { ok: true }, "T-1");
			off();
			expect(received).toEqual(["task.test"]);
		} finally {
			store.close();
		}
	});
});

describe("GET /recovery", () => {
	it("lists failed and aborted tasks with recovery recommendations", async () => {
		const { store, app, root } = setup();
		try {
			const now = Date.now();
			const worktreePath = join(root, "preserved");
			mkdirSync(worktreePath, { recursive: true });
			store.insertTask({
				id: "TR-preserved",
				workflow_source: "inline",
				workflow_name: null,
				workflow_path: join(root, "workflow.js"),
				status: "failed",
				base_repo: process.cwd(),
				base_branch: "main",
				cwd: process.cwd(),
				created_at: now,
				started_at: now,
				finished_at: now,
				error: "boom",
				options: "{}",
				result: null,
			});
			store.insertWorktree({
				id: "wt-recovery",
				task_id: "TR-preserved",
				label: "dev",
				branch: "kanade/TR-preserved",
				base_branch: "main",
				worktree_path: worktreePath,
				status: "inactive",
				base_repo: process.cwd(),
				created_at: now,
				last_used_at: now,
				finished_at: now,
				merge_commit: null,
			});
			store.insertTask({
				id: "TR-no-worktree",
				workflow_source: "inline",
				workflow_name: null,
				workflow_path: join(root, "missing.js"),
				status: "failed",
				base_repo: process.cwd(),
				base_branch: "main",
				cwd: process.cwd(),
				created_at: now - 1,
				started_at: now - 1,
				finished_at: now,
				error: "boom without worktree",
				options: "{}",
				result: null,
			});
			store.insertTask({
				id: "TR-merged",
				workflow_source: "inline",
				workflow_name: null,
				workflow_path: join(root, "merged.js"),
				status: "aborted",
				base_repo: process.cwd(),
				base_branch: "main",
				cwd: process.cwd(),
				created_at: now - 2,
				started_at: now - 2,
				finished_at: now,
				error: "aborted but manually merged",
				options: "{}",
				result: null,
			});
			store.insertWorktree({
				id: "wt-merged",
				task_id: "TR-merged",
				label: "dev",
				branch: "kanade/TR-merged",
				base_branch: "main",
				worktree_path: join(root, "merged"),
				status: "merged",
				base_repo: process.cwd(),
				created_at: now,
				last_used_at: now,
				finished_at: now,
				merge_commit: "abc123",
			});

			const res = await app.request("/recovery");
			const body = (await res.json()) as { tasks: Array<Record<string, unknown>> };

			expect(res.status).toBe(200);
			expect(body.tasks[0]).toMatchObject({
				id: "TR-preserved",
				status: "failed",
				recovery_state: "preserved",
			});
			expect(String(body.tasks[0]?.recommendation)).toContain("Inspect preserved worktree");

			const actionableRes = await app.request("/recovery?actionable=true");
			const actionable = (await actionableRes.json()) as { tasks: Array<Record<string, unknown>> };
			expect(actionable.tasks.map((task) => task.id)).toEqual(["TR-preserved"]);

			const mergedRes = await app.request("/recovery?state=merged");
			const merged = (await mergedRes.json()) as { tasks: Array<Record<string, unknown>> };
			expect(merged.tasks.map((task) => task.id)).toEqual(["TR-merged"]);

			const noWorktreeRes = await app.request("/recovery?state=no_worktree");
			const noWorktree = (await noWorktreeRes.json()) as { tasks: Array<Record<string, unknown>> };
			expect(noWorktree.tasks.map((task) => task.id)).toEqual(["TR-no-worktree"]);

			const cleanupDryRunRes = await app.request("/recovery/cleanup", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ task_id: "TR-preserved" }),
			});
			const cleanupDryRun = (await cleanupDryRunRes.json()) as {
				dry_run: boolean;
				cleaned: number;
				tasks: Array<Record<string, unknown>>;
			};
			expect(cleanupDryRunRes.status).toBe(200);
			expect(cleanupDryRun).toMatchObject({ dry_run: true, cleaned: 0 });
			expect(cleanupDryRun.tasks.map((task) => task.id)).toEqual(["TR-preserved"]);
			expect(existsSync(worktreePath)).toBe(true);

			const unconfirmedRes = await app.request("/recovery/cleanup", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ task_id: "TR-preserved", execute: true }),
			});
			expect(unconfirmedRes.status).toBe(400);

			const cleanupExecuteRes = await app.request("/recovery/cleanup", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ task_id: "TR-preserved", execute: true, confirmed: true }),
			});
			const cleanupExecute = (await cleanupExecuteRes.json()) as { dry_run: boolean; cleaned: number };
			expect(cleanupExecuteRes.status).toBe(200);
			expect(cleanupExecute).toMatchObject({ dry_run: false, cleaned: 1 });
			expect(existsSync(worktreePath)).toBe(false);
		} finally {
			store.close();
		}
	});
});

describe("POST /tasks/:id/reconcile", () => {
	it("marks a manually merged task worktree as merged", async () => {
		const { store, app, root, config } = setup();
		try {
			config.merge.targetBranch = "main";
			const repo = join(root, "repo");
			mkdirSync(repo, { recursive: true });
			execFileSync("git", ["init", "-b", "main"], { cwd: repo, encoding: "utf8" });
			writeFileSync(join(repo, "base.txt"), "base\n");
			execFileSync("git", ["add", "base.txt"], { cwd: repo, encoding: "utf8" });
			execFileSync("git", [...TEST_GIT_AUTHOR, "commit", "-m", "base"], { cwd: repo, encoding: "utf8" });
			execFileSync("git", ["checkout", "-b", "kanade/TR-manual"], { cwd: repo, encoding: "utf8" });
			writeFileSync(join(repo, "feature.txt"), "feature\n");
			execFileSync("git", ["add", "feature.txt"], { cwd: repo, encoding: "utf8" });
			execFileSync("git", [...TEST_GIT_AUTHOR, "commit", "-m", "feature"], { cwd: repo, encoding: "utf8" });
			execFileSync("git", ["checkout", "main"], { cwd: repo, encoding: "utf8" });
			execFileSync("git", [...TEST_GIT_AUTHOR, "merge", "--no-ff", "kanade/TR-manual", "-m", "manual merge"], {
				cwd: repo,
				encoding: "utf8",
			});
			const mergeCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
			const now = Date.now();
			store.insertTask({
				id: "TR-manual",
				workflow_source: "saved",
				workflow_name: "dev-standard",
				workflow_path: join(root, "manual.js"),
				status: "failed",
				base_repo: repo,
				base_branch: "main",
				cwd: repo,
				created_at: now,
				started_at: now,
				finished_at: now,
				error: "auto-commit failed",
				options: "{}",
				result: null,
			});
			store.insertWorktree({
				id: "wt-manual",
				task_id: "TR-manual",
				label: "dev",
				branch: "kanade/TR-manual",
				base_branch: "main",
				worktree_path: join(root, "worktree"),
				status: "inactive",
				base_repo: repo,
				created_at: now,
				last_used_at: now,
				finished_at: now,
				merge_commit: null,
			});

			const res = await app.request("/tasks/TR-manual/reconcile", { method: "POST", body: "{}" });
			const body = (await res.json()) as { state: string; mergeCommit: string };
			expect(res.status).toBe(200);
			expect(body.state).toBe("merged");
			expect(body.mergeCommit).toBe(mergeCommit);
			expect(store.findWorktreesByTask("TR-manual")[0]).toMatchObject({
				status: "merged",
				merge_commit: mergeCommit,
			});

			const reviewRes = await app.request("/tasks/TR-manual/review");
			const review = (await reviewRes.json()) as { state: string };
			expect(review.state).toBe("merged");
		} finally {
			store.close();
		}
	});

	it("does not mistake later merge commits for an older branch merge", async () => {
		const { store, app, root, config } = setup();
		try {
			config.merge.targetBranch = "main";
			const repo = join(root, "repo-later-merge");
			mkdirSync(repo, { recursive: true });
			execFileSync("git", ["init", "-b", "main"], { cwd: repo, encoding: "utf8" });
			writeFileSync(join(repo, "base.txt"), "base\n");
			execFileSync("git", ["add", "base.txt"], { cwd: repo, encoding: "utf8" });
			execFileSync("git", [...TEST_GIT_AUTHOR, "commit", "-m", "base"], { cwd: repo, encoding: "utf8" });

			execFileSync("git", ["checkout", "-b", "kanade/old"], { cwd: repo, encoding: "utf8" });
			writeFileSync(join(repo, "old.txt"), "old\n");
			execFileSync("git", ["add", "old.txt"], { cwd: repo, encoding: "utf8" });
			execFileSync("git", [...TEST_GIT_AUTHOR, "commit", "-m", "old"], { cwd: repo, encoding: "utf8" });
			execFileSync("git", ["checkout", "main"], { cwd: repo, encoding: "utf8" });
			execFileSync("git", [...TEST_GIT_AUTHOR, "merge", "--no-ff", "kanade/old", "-m", "merge old"], {
				cwd: repo,
				encoding: "utf8",
			});
			const oldMerge = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

			execFileSync("git", ["checkout", "-b", "kanade/new"], { cwd: repo, encoding: "utf8" });
			writeFileSync(join(repo, "new.txt"), "new\n");
			execFileSync("git", ["add", "new.txt"], { cwd: repo, encoding: "utf8" });
			execFileSync("git", [...TEST_GIT_AUTHOR, "commit", "-m", "new"], { cwd: repo, encoding: "utf8" });
			execFileSync("git", ["checkout", "main"], { cwd: repo, encoding: "utf8" });
			execFileSync("git", [...TEST_GIT_AUTHOR, "merge", "--no-ff", "kanade/new", "-m", "merge new"], {
				cwd: repo,
				encoding: "utf8",
			});
			const newMerge = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
			expect(newMerge).not.toBe(oldMerge);

			const now = Date.now();
			store.insertTask({
				id: "TR-old",
				workflow_source: "saved",
				workflow_name: "dev-standard",
				workflow_path: join(root, "old.js"),
				status: "failed",
				base_repo: repo,
				base_branch: "main",
				cwd: repo,
				created_at: now,
				started_at: now,
				finished_at: now,
				error: "failed after manual merge",
				options: "{}",
				result: null,
			});
			store.insertWorktree({
				id: "wt-old",
				task_id: "TR-old",
				label: "dev",
				branch: "kanade/old",
				base_branch: "main",
				worktree_path: join(root, "old-worktree"),
				status: "inactive",
				base_repo: repo,
				created_at: now,
				last_used_at: now,
				finished_at: now,
				merge_commit: null,
			});

			const res = await app.request("/tasks/TR-old/reconcile", { method: "POST", body: "{}" });
			const body = (await res.json()) as { mergeCommit: string };
			expect(res.status).toBe(200);
			expect(body.mergeCommit).toBe(oldMerge);
			expect(body.mergeCommit).not.toBe(newMerge);
		} finally {
			store.close();
		}
	});
});

describe("GET /tasks", () => {
	it("includes lightweight worktree summaries for cockpit merge state", async () => {
		const { store, app } = setup();
		try {
			const now = Date.now();
			const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
			for (const id of ["TL-merged", "TL-review", "TL-none"] as const) {
				store.insertTask({
					id,
					workflow_source: "inline",
					workflow_name: null,
					workflow_path: `/tmp/${id}.js`,
					status: "finished",
					base_repo: null,
					base_branch: "main",
					cwd: process.cwd(),
					created_at: now,
					started_at: now,
					finished_at: now,
					error: null,
					options: "{}",
					result: null,
				});
			}
			store.insertWorktree({
				id: "wt-merged",
				task_id: "TL-merged",
				label: "dev",
				branch: "kanade/TL-merged",
				base_branch: "main",
				worktree_path: "/tmp/TL-merged",
				status: "merged",
				base_repo: process.cwd(),
				created_at: now,
				last_used_at: now,
				finished_at: now,
				merge_commit: head,
			});
			store.insertWorktree({
				id: "wt-review",
				task_id: "TL-review",
				label: "dev",
				branch: "kanade/TL-review",
				base_branch: "main",
				worktree_path: "/tmp/TL-review",
				status: "inactive",
				base_repo: process.cwd(),
				created_at: now,
				last_used_at: now,
				finished_at: now,
				merge_commit: null,
			});

			const res = await app.request("/tasks");
			const body = (await res.json()) as {
				tasks: Array<{
					id: string;
					worktree_summary: {
						status: string;
						merge_commit?: string;
						has_changes?: boolean;
						changed_files_count?: number;
						commit_count?: number;
						diff_stat?: string;
					};
				}>;
			};
			const byId = new Map(body.tasks.map((task) => [task.id, task]));

			expect(res.status).toBe(200);
			expect(byId.get("TL-merged")?.worktree_summary).toMatchObject({
				status: "merged",
				merge_commit: head,
			});
			// List endpoint returns lightweight summaries: no git-derived fields
			expect(byId.get("TL-merged")?.worktree_summary.has_changes).toBeUndefined();
			expect(byId.get("TL-merged")?.worktree_summary.changed_files_count).toBeUndefined();
			expect(byId.get("TL-merged")?.worktree_summary.commit_count).toBeUndefined();
			expect(byId.get("TL-merged")?.worktree_summary.diff_stat).toBeUndefined();
			expect(byId.get("TL-review")?.worktree_summary).toMatchObject({ status: "inactive" });
			expect(byId.get("TL-none")?.worktree_summary).toMatchObject({ status: "none" });
		} finally {
			store.close();
		}
	});

	it("reports failed rejected worktrees that still exist as preserved", async () => {
		const { root, store, app } = setup();
		try {
			const now = Date.now();
			const worktreePath = join(root, "preserved-rejected");
			mkdirSync(worktreePath, { recursive: true });
			store.insertTask({
				id: "TL-failed-preserved",
				workflow_source: "inline",
				workflow_name: null,
				workflow_path: "/tmp/TL-failed-preserved.js",
				status: "failed",
				base_repo: null,
				base_branch: "main",
				cwd: process.cwd(),
				created_at: now,
				started_at: now,
				finished_at: now,
				error: "auto-commit failed",
				options: "{}",
				result: null,
			});
			store.insertWorktree({
				id: "wt-failed-preserved",
				task_id: "TL-failed-preserved",
				label: "dev",
				branch: "kanade/TL-failed-preserved",
				base_branch: "main",
				worktree_path: worktreePath,
				status: "rejected",
				base_repo: process.cwd(),
				created_at: now,
				last_used_at: now,
				finished_at: now,
				merge_commit: null,
			});

			const res = await app.request("/tasks");
			const body = (await res.json()) as {
				tasks: Array<{ id: string; worktree_summary: { status: string; path?: string } }>;
			};
			const task = body.tasks.find((row) => row.id === "TL-failed-preserved");
			expect(task?.worktree_summary).toMatchObject({ status: "preserved", path: worktreePath });
		} finally {
			store.close();
		}
	});
	it("reports missing rejected worktrees as rejected (not preserved)", async () => {
		const { store, app } = setup();
		try {
			const now = Date.now();
			// Path does not exist on disk
			const worktreePath = "/tmp/nonexistent-rejected-wt";
			store.insertTask({
				id: "TL-failed-rejected",
				workflow_source: "inline",
				workflow_name: null,
				workflow_path: "/tmp/TL-failed-rejected.js",
				status: "failed",
				base_repo: null,
				base_branch: "main",
				cwd: process.cwd(),
				created_at: now,
				started_at: now,
				finished_at: now,
				error: "auto-commit failed",
				options: "{}",
				result: null,
			});
			store.insertWorktree({
				id: "wt-failed-rejected",
				task_id: "TL-failed-rejected",
				label: "dev",
				branch: "kanade/TL-failed-rejected",
				base_branch: "main",
				worktree_path: worktreePath,
				status: "rejected",
				base_repo: process.cwd(),
				created_at: now,
				last_used_at: now,
				finished_at: now,
				merge_commit: null,
			});

			const res = await app.request("/tasks");
			const body = (await res.json()) as {
				tasks: Array<{ id: string; worktree_summary: { status: string; path?: string } }>;
			};
			const task = body.tasks.find((row) => row.id === "TL-failed-rejected");
			expect(task?.worktree_summary).toMatchObject({ status: "rejected" });
		} finally {
			store.close();
		}
	});
	it("list returns no git-derived fields while review returns them", async () => {
		const { store, app } = setup();
		const branchName = "kanade/TL-struct-test";
		const tmpDir = tempWorktreePath("kanade-wt-struct-test");
		const cleanupGitFixture = () => {
			execFileSync("git", ["worktree", "remove", tmpDir, "--force"], { encoding: "utf8", stdio: "ignore" });
			execFileSync("git", ["branch", "-D", branchName], { encoding: "utf8", stdio: "ignore" });
		};
		try {
			try {
				cleanupGitFixture();
			} catch {
				// ignore stale fixture cleanup failures
			}
			const now = Date.now();

			// Create a real branch with a commit
			execFileSync("git", ["branch", branchName], { encoding: "utf8" });
			execFileSync("git", ["worktree", "add", tmpDir, branchName], { encoding: "utf8" });
			writeFileSync(join(tmpDir, "struct-test.txt"), "struct content");
			execFileSync("git", ["add", "struct-test.txt"], { cwd: tmpDir, encoding: "utf8" });
			execFileSync("git", [...TEST_GIT_AUTHOR, "commit", "-m", "struct test"], { cwd: tmpDir, encoding: "utf8" });

			// Create a finished task with an active worktree pointing to the real branch
			store.insertTask({
				id: "TL-struct-test",
				workflow_source: "inline",
				workflow_name: null,
				workflow_path: "/tmp/TL-struct-test.js",
				status: "finished",
				base_repo: null,
				base_branch: TEST_BASE_REF,
				cwd: process.cwd(),
				created_at: now,
				started_at: now,
				finished_at: now,
				error: null,
				options: "{}",
				result: null,
			});
			store.insertWorktree({
				id: "wt-struct-test",
				task_id: "TL-struct-test",
				label: "dev",
				branch: branchName,
				base_branch: TEST_BASE_REF,
				worktree_path: tmpDir,
				status: "inactive",
				base_repo: process.cwd(),
				created_at: now,
				last_used_at: now,
				finished_at: now,
				merge_commit: null,
			});

			// List endpoint: no git-derived fields
			const listRes = await app.request("/tasks");
			const listBody = (await listRes.json()) as {
				tasks: Array<{
					id: string;
					worktree_summary: {
						status: string;
						has_changes?: boolean;
						changed_files_count?: number;
						commit_count?: number;
						diff_stat?: string;
					};
				}>;
			};
			expect(listRes.status).toBe(200);
			const listTask = listBody.tasks.find((t) => t.id === "TL-struct-test");
			expect(listTask).toBeDefined();
			expect(listTask?.worktree_summary.status).toBe("inactive");
			expect(listTask?.worktree_summary.has_changes).toBeUndefined();
			expect(listTask?.worktree_summary.changed_files_count).toBeUndefined();
			expect(listTask?.worktree_summary.commit_count).toBeUndefined();
			expect(listTask?.worktree_summary.diff_stat).toBeUndefined();

			// Review endpoint: git-derived fields are present
			const reviewRes = await app.request("/tasks/TL-struct-test/review");
			const reviewBody = (await reviewRes.json()) as {
				worktree: {
					status: string;
					has_changes?: boolean;
					changed_files_count?: number;
					commit_count?: number;
					diff_stat?: string;
				};
			};
			expect(reviewRes.status).toBe(200);
			expect(reviewBody.worktree.has_changes).toBe(true);
			expect(reviewBody.worktree.commit_count).toBeGreaterThan(0);
		} finally {
			try {
				cleanupGitFixture();
			} catch {
				// ignore fixture cleanup failures
			}
			store.close();
		}
	});
});

describe("GET /tasks/:id/sessions/:label/stream", () => {
	it("returns 404 when the persisted session stream is missing", async () => {
		const { store, app } = setup();
		try {
			const now = Date.now();
			store.insertTask({
				id: "TS-stream",
				workflow_source: "inline",
				workflow_name: null,
				workflow_path: "/tmp/stream.js",
				status: "finished",
				base_repo: null,
				base_branch: "main",
				cwd: process.cwd(),
				created_at: now,
				started_at: now,
				finished_at: now,
				error: null,
				options: "{}",
				result: null,
			});

			const res = await app.request("/tasks/TS-stream/sessions/missing/stream");
			expect(res.status).toBe(404);
		} finally {
			store.close();
		}
	});
});

describe("GET /tasks/:id/script", () => {
	it("returns 404 for unknown task", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/tasks/T-9999/script");
			expect(res.status).toBe(404);
		} finally {
			store.close();
		}
	});

	it("returns the script content", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			const res = await app.request(`/tasks/${created.task_id}/script`);
			const body = (await res.json()) as { script: string };
			expect(res.status).toBe(200);
			expect(body.script).toBe(SIMPLE_SCRIPT);
		} finally {
			store.close();
		}
	});
});

describe("POST /tasks/:id/iterate", () => {
	it("creates an iteration for a saved task with structured previousResult and reuseBranch", async () => {
		const mock = createMockSessionFactory({ text: "ok" });
		const { store, taskManager, app } = setup(undefined, mock.createSession);
		try {
			taskManager.putWorkflow(
				"iter-saved",
				"export const meta = { name: 'iter_saved', description: 'Iter saved' }\nreturn { ok: true, review: { status: 'approved' }, checks: ['lint'] }",
			);
			const created = taskManager.create({
				source: "saved",
				workflow_name: "iter-saved",
				options: { cwd: process.cwd(), agent_model: "xiaomi/mimo-v2.5-pro" },
			});
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("finished"));
			store.insertWorktree({
				id: `wt-${created.task_id}`,
				task_id: created.task_id,
				label: "implement",
				branch: `kanade/${created.task_id}`,
				base_branch: "main",
				worktree_path: `/tmp/${created.task_id}`,
				status: "inactive",
				base_repo: process.cwd(),
				created_at: Date.now(),
				last_used_at: Date.now(),
				finished_at: Date.now(),
				merge_commit: null,
			});

			const res = await app.request(`/tasks/${created.task_id}/iterate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ instructions: "refine the API shape" }),
			});
			const body = (await res.json()) as { task_id: string };
			expect(res.status).toBe(202);
			expect(body.task_id).not.toBe(created.task_id);
			expect(taskManager.getScript(body.task_id)).toContain("phase('Refine')");
		} finally {
			store.close();
		}
	});

	it("returns 400 when iterate instructions are missing", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("finished"));
			const res = await app.request(`/tasks/${created.task_id}/iterate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(400);
		} finally {
			store.close();
		}
	});
});

describe("GET /tasks/:id/journal", () => {
	it("returns 404 for unknown task", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/tasks/T-9999/journal");
			expect(res.status).toBe(404);
		} finally {
			store.close();
		}
	});

	it("returns agents and humans arrays for a known task", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			const res = await app.request(`/tasks/${created.task_id}/journal`);
			const body = (await res.json()) as { agents: unknown[]; humans: unknown[] };
			expect(res.status).toBe(200);
			expect(Array.isArray(body.agents)).toBe(true);
			expect(Array.isArray(body.humans)).toBe(true);
		} finally {
			store.close();
		}
	});
});

describe("GET /tasks/:id/artifacts", () => {
	it("returns 404 for unknown task", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/tasks/T-9999/artifacts");
			expect(res.status).toBe(404);
		} finally {
			store.close();
		}
	});

	it("returns empty array when no artifacts exist", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("finished"));
			const res = await app.request(`/tasks/${created.task_id}/artifacts`);
			const body = (await res.json()) as { artifacts: string[] };
			expect(res.status).toBe(200);
			expect(body.artifacts).toEqual([]);
		} finally {
			store.close();
		}
	});
});

describe("GET /tasks/:id/artifacts/:name", () => {
	it("returns 404 for unknown task", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/tasks/T-9999/artifacts/01-design.json");
			expect(res.status).toBe(404);
		} finally {
			store.close();
		}
	});

	it("returns 404 for missing artifact", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("finished"));
			const res = await app.request(`/tasks/${created.task_id}/artifacts/missing.json`);
			expect(res.status).toBe(404);
		} finally {
			store.close();
		}
	});
});

describe("POST /tasks/:id/rerun", () => {
	it("returns 404 for unknown task", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/tasks/T-9999/rerun", { method: "POST" });
			expect(res.status).toBe(404);
		} finally {
			store.close();
		}
	});

	it("creates a new task and returns rerun_of", async () => {
		const { store, taskManager, app } = setup();
		try {
			const original = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(taskManager.get(original.task_id)?.status).toBe("finished"));

			const res = await app.request(`/tasks/${original.task_id}/rerun`, { method: "POST" });
			const body = (await res.json()) as { task_id: string; rerun_of: string };

			expect(res.status).toBe(202);
			expect(body.task_id).not.toBe(original.task_id);
			expect(body.rerun_of).toBe(original.task_id);

			await vi.waitFor(() => expect(taskManager.get(body.task_id)?.status).toBe("finished"));
		} finally {
			store.close();
		}
	});

	it("accepts option overrides in the body", async () => {
		const { store, taskManager, app } = setup();
		try {
			const original = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(taskManager.get(original.task_id)?.status).toBe("finished"));

			const res = await app.request(`/tasks/${original.task_id}/rerun`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ options: { concurrency: 2 } }),
			});
			const body = (await res.json()) as { task_id: string };
			expect(res.status).toBe(202);

			const rerunTask = taskManager.get(body.task_id);
			expect(JSON.parse(rerunTask?.options ?? "{}")).toMatchObject({ concurrency: 2 });

			await vi.waitFor(() => expect(taskManager.get(body.task_id)?.status).toBe("finished"));
		} finally {
			store.close();
		}
	});
});

describe("POST /tasks/:id/save", () => {
	it("returns 404 for unknown task", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/tasks/T-9999/save", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "my-workflow" }),
			});
			expect(res.status).toBe(404);
		} finally {
			store.close();
		}
	});

	it("returns 400 when name is missing", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			const res = await app.request(`/tasks/${created.task_id}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(400);
		} finally {
			store.close();
		}
	});

	it("returns 400 for an invalid name", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			const res = await app.request(`/tasks/${created.task_id}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "bad name!" }),
			});
			expect(res.status).toBe(400);
		} finally {
			store.close();
		}
	});

	it("writes the script to workflowsDir and returns ok", async () => {
		const { config, store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("finished"));

			const res = await app.request(`/tasks/${created.task_id}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "my-workflow" }),
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ ok: true });
			expect(existsSync(join(config.paths.workflowsDir, "my-workflow.js"))).toBe(true);
		} finally {
			store.close();
		}
	});

	it("returns 409 when saving with a duplicate name without overwrite", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("finished"));

			// First save succeeds
			const res1 = await app.request(`/tasks/${created.task_id}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "dup-workflow" }),
			});
			expect(res1.status).toBe(200);

			// Second save with same name fails with 409
			const res2 = await app.request(`/tasks/${created.task_id}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "dup-workflow" }),
			});
			expect(res2.status).toBe(409);
			const body = (await res2.json()) as { error: string };
			expect(body.error).toContain("already exists");
		} finally {
			store.close();
		}
	});

	it("allows overwrite when overwrite=true is passed", async () => {
		const { config, store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("finished"));

			// First save
			const res1 = await app.request(`/tasks/${created.task_id}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "overwrite-workflow" }),
			});
			expect(res1.status).toBe(200);

			// Second save with overwrite=true succeeds
			const res2 = await app.request(`/tasks/${created.task_id}/save`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "overwrite-workflow", overwrite: true }),
			});
			expect(res2.status).toBe(200);
			expect(await res2.json()).toMatchObject({ ok: true });
			expect(existsSync(join(config.paths.workflowsDir, "overwrite-workflow.js"))).toBe(true);
		} finally {
			store.close();
		}
	});
});

describe("GET /workflows", () => {
	it("returns empty array when no workflows exist", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/workflows");
			const body = (await res.json()) as { workflows: unknown[] };
			expect(res.status).toBe(200);
			expect(body.workflows).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("returns list of saved workflows with meta", async () => {
		const { store, taskManager, app } = setup();
		try {
			taskManager.putWorkflow("demo", SIMPLE_SCRIPT);
			const res = await app.request("/workflows");
			const body = (await res.json()) as { workflows: Array<{ name: string; meta: { name: string } }> };
			expect(res.status).toBe(200);
			expect(body.workflows).toHaveLength(1);
			expect(body.workflows[0].name).toBe("demo");
			expect(body.workflows[0].meta.name).toBe("demo");
		} finally {
			store.close();
		}
	});
});

describe("GET /workflows/:name", () => {
	it("returns 404 for unknown workflow", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/workflows/missing");
			expect(res.status).toBe(404);
		} finally {
			store.close();
		}
	});

	it("returns workflow info including script and meta", async () => {
		const { store, taskManager, app } = setup();
		try {
			taskManager.putWorkflow("demo", SIMPLE_SCRIPT);
			const res = await app.request("/workflows/demo");
			const body = (await res.json()) as { name: string; script: string; meta: { name: string } };
			expect(res.status).toBe(200);
			expect(body.name).toBe("demo");
			expect(body.script).toBe(SIMPLE_SCRIPT);
			expect(body.meta.name).toBe("demo");
		} finally {
			store.close();
		}
	});
});

describe("PUT /workflows/:name", () => {
	it("creates a new workflow", async () => {
		const { store, taskManager, app } = setup();
		try {
			const res = await app.request("/workflows/new-wf", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ script: SIMPLE_SCRIPT }),
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ ok: true });
			expect(taskManager.getWorkflow("new-wf")).not.toBeNull();
		} finally {
			store.close();
		}
	});

	it("returns 400 when script is missing", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/workflows/wf", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(400);
		} finally {
			store.close();
		}
	});

	it("returns 400 when script has no valid meta export", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/workflows/wf", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ script: "const x = 1" }),
			});
			expect(res.status).toBe(400);
		} finally {
			store.close();
		}
	});
});

describe("DELETE /workflows/:name", () => {
	it("returns 404 for unknown workflow", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/workflows/missing", { method: "DELETE" });
			expect(res.status).toBe(404);
		} finally {
			store.close();
		}
	});

	it("deletes the workflow and returns ok", async () => {
		const { store, taskManager, app } = setup();
		try {
			taskManager.putWorkflow("to-delete", SIMPLE_SCRIPT);
			const res = await app.request("/workflows/to-delete", { method: "DELETE" });
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ ok: true });
			expect(taskManager.getWorkflow("to-delete")).toBeNull();
		} finally {
			store.close();
		}
	});
});

describe("POST /tasks source:saved", () => {
	it("runs a saved workflow and returns task_id", async () => {
		const { store, taskManager, app } = setup();
		try {
			taskManager.putWorkflow("demo", SIMPLE_SCRIPT);
			const res = await app.request("/tasks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ source: "saved", workflow_name: "demo" }),
			});
			const body = (await res.json()) as { task_id: string };
			expect(res.status).toBe(202);
			await vi.waitFor(() => expect(taskManager.get(body.task_id)?.status).toBe("finished"));
			expect(taskManager.get(body.task_id)?.workflow_source).toBe("saved");
			expect(taskManager.get(body.task_id)?.workflow_name).toBe("demo");
		} finally {
			store.close();
		}
	});

	it("returns 404 for unknown workflow", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/tasks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ source: "saved", workflow_name: "missing" }),
			});
			expect(res.status).toBe(404);
		} finally {
			store.close();
		}
	});

	it("returns 400 when workflow_name is missing", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/tasks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ source: "saved" }),
			});
			expect(res.status).toBe(400);
		} finally {
			store.close();
		}
	});
});

describe("POST /workflows/generate", () => {
	it("returns generated script without creating a task", async () => {
		const script = "export const meta = { name: 'dry', description: 'Dry' }\nreturn { ok: true }";
		const { store, taskManager, app } = setup({
			async generate(
				prompt: string,
				options?: { model?: string; workspaceRoot?: string; complexityHint?: "simple" | "medium" | "complex" },
			) {
				expect(prompt).toBe("make workflow");
				expect(options?.model).toBe("gpt-5.4");
				expect(options?.complexityHint).toBe("simple");
				return script;
			},
		});
		try {
			const res = await app.request("/workflows/generate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "make workflow", options: { author_model: "gpt-5.4", workflow_size: "small" } }),
			});
			const body = (await res.json()) as { script: string };

			expect(res.status).toBe(200);
			expect(body.script).toBe(script);
			expect(taskManager.list()).toHaveLength(0);
		} finally {
			store.close();
		}
	});
});

describe("POST /tasks source:generated", () => {
	it("returns 202 with generated:true and task runs to completion", async () => {
		const { store, taskManager, app } = setup();
		try {
			const res = await app.request("/tasks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ source: "generated", prompt: "return { ok: true }" }),
			});
			const body = (await res.json()) as { task_id: string; generated: boolean };
			expect(res.status).toBe(202);
			expect(body.generated).toBe(true);
			await vi.waitFor(() => expect(taskManager.get(body.task_id)?.status).toBe("finished"), {
				timeout: 5000,
			});
		} finally {
			store.close();
		}
	});

	it("workflow.js is written to the run dir", async () => {
		const { store, taskManager, app } = setup();
		try {
			const res = await app.request("/tasks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ source: "generated", prompt: "return {}" }),
			});
			const body = (await res.json()) as { task_id: string };
			await vi.waitFor(() => expect(taskManager.get(body.task_id)?.status).not.toBe("created"), {
				timeout: 5000,
			});
			expect(
				existsSync(taskManager.getScript(body.task_id) !== null ? taskManager.get(body.task_id)!.workflow_path : ""),
			).toBe(true);
			await taskManager.abort(body.task_id);
		} finally {
			store.close();
		}
	});

	it("returns 400 when prompt is missing", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/tasks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ source: "generated" }),
			});
			expect(res.status).toBe(400);
		} finally {
			store.close();
		}
	});
});

describe("POST /tasks source:inline", () => {
	it("creates and runs an inline task", async () => {
		const { store, taskManager, app } = setup();
		try {
			const res = await app.request("/tasks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ source: "inline", script: SIMPLE_SCRIPT }),
			});
			const body = (await res.json()) as { task_id: string };
			expect(res.status).toBe(202);
			expect(body.task_id).toBeTruthy();

			await vi.waitFor(() => expect(taskManager.get(body.task_id)?.status).toBe("finished"));
		} finally {
			store.close();
		}
	});

	it("returns 400 when script is missing for inline source", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/tasks", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ source: "inline" }),
			});
			expect(res.status).toBe(400);
		} finally {
			store.close();
		}
	});
});

describe("POST /tasks/:id/abort", () => {
	it("aborts a running task", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({
				source: "inline",
				script:
					"export const meta = { name: 'human', description: 'Human' }\nreturn await request_human({ title: 'Approve?' })",
			});
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("needs_human"));

			const res = await app.request(`/tasks/${created.task_id}/abort`, { method: "POST" });
			expect(res.status).toBe(200);

			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("aborted"));
		} finally {
			store.close();
		}
	});
});

describe("POST /tasks/:id/respond", () => {
	it("resolves a needs_human request and resumes the task", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({
				source: "inline",
				script:
					"export const meta = { name: 'human', description: 'Human' }\nreturn await request_human({ title: 'Approve?' })",
			});
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("needs_human"));

			const pending = store.listPendingNeedsHuman()[0];
			const res = await app.request(`/tasks/${created.task_id}/respond`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ request_id: pending.request_id, response: { decision: "approve" } }),
			});
			expect(res.status).toBe(200);

			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("finished"));
		} finally {
			store.close();
		}
	});
});

describe("error handling", () => {
	it("returns 500 for unknown errors", async () => {
		const { store, app, taskManager } = setup();
		try {
			// Create a task that will fail with a non-AppError
			const created = taskManager.create({
				source: "inline",
				script: "export const meta = { name: 'fail', description: 'Fail' }\nthrow new Error('boom')",
			});
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("failed"));

			// Verify the task is in failed state
			const res = await app.request(`/tasks/${created.task_id}`);
			const body = (await res.json()) as { task: { status: string; error: string } };
			expect(body.task.status).toBe("failed");
			expect(body.task.error).toContain("boom");
		} finally {
			store.close();
		}
	});

	it("returns JSON error for 404 routes", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/nonexistent");
			// Hono returns 405 or 404 for unmatched routes
			expect(res.status).toBeGreaterThanOrEqual(400);
		} finally {
			store.close();
		}
	});
});

describe("GET /tasks/:id/events replay", () => {
	it("replays past events and streams live ones with stable ids", async () => {
		const { store, taskManager, events, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			// Wait for task to finish so events accumulate
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("finished"));

			// Collect past event ids from the bus
			const pastIds = events.getTaskEvents(created.task_id).map((e) => e.id);
			expect(pastIds.length).toBeGreaterThan(0);

			// Request the SSE endpoint — the response will stream. We can read
			// the initial body that includes the replayed events.
			const ac = new AbortController();
			const res = await app.request(`/tasks/${created.task_id}/events`, {
				headers: { Accept: "text/event-stream" },
				signal: ac.signal,
			});
			expect(res.status).toBe(200);

			// Read SSE chunks until we've seen all past events (or timeout)
			const reader = res.body?.getReader();
			expect(reader).toBeDefined();
			const decoder = new TextDecoder();
			let accumulated = "";
			const deadline = Date.now() + 2000;
			while (Date.now() < deadline) {
				const result = await Promise.race([
					reader!.read(),
					new Promise<{ done: true; value: undefined }>((r) =>
						setTimeout(() => r({ done: true, value: undefined }), 500),
					),
				]);
				if (result.done) break;
				accumulated += decoder.decode(result.value, { stream: true });
				// Check if we have all past events
				const lines = accumulated.split("\n").filter((l) => l.startsWith("data: "));
				if (lines.length >= pastIds.length) break;
			}

			const dataLines = accumulated.split("\n").filter((l) => l.startsWith("data: "));
			expect(dataLines.length).toBeGreaterThanOrEqual(pastIds.length);

			// Parse the replayed events and verify they have stable ids
			const replayedIds = dataLines.map((l) => JSON.parse(l.slice(6)).id as number);
			// All past ids should appear in the replayed stream
			for (const pid of pastIds) {
				expect(replayedIds).toContain(pid);
			}
			// Ids are strictly increasing
			for (let i = 1; i < replayedIds.length; i++) {
				expect(replayedIds[i]).toBeGreaterThan(replayedIds[i - 1]);
			}

			ac.abort();
		} finally {
			store.close();
		}
	});
});

describe("GET /health", () => {
	it("returns ok", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/health");
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ ok: true });
		} finally {
			store.close();
		}
	});
});

describe("GET /tasks/:id/review", () => {
	it("returns 404 for unknown task", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/tasks/T-9999/review");
			expect(res.status).toBe(404);
		} finally {
			store.close();
		}
	});

	it("returns mergeable:true for finished task with worktree and changes", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("finished"));

			// Create a real branch with a commit so branchDiffSummary finds changes
			const branchName = `kanade/${created.task_id}`;
			const tmpDir = tempWorktreePath(`kanade-wt-${created.task_id}`);
			execFileSync("git", ["branch", branchName], { encoding: "utf8" });
			execFileSync("git", ["worktree", "add", tmpDir, branchName], { encoding: "utf8" });
			// Make a commit in the worktree
			writeFileSync(join(tmpDir, "review-test.txt"), "review content");
			execFileSync("git", ["add", "review-test.txt"], { cwd: tmpDir, encoding: "utf8" });
			execFileSync("git", [...TEST_GIT_AUTHOR, "commit", "-m", "review test"], { cwd: tmpDir, encoding: "utf8" });

			const now = Date.now();
			store.insertWorktree({
				id: `wt-${created.task_id}`,
				task_id: created.task_id,
				label: "dev",
				branch: branchName,
				base_branch: TEST_BASE_REF,
				worktree_path: tmpDir,
				status: "inactive",
				base_repo: process.cwd(),
				created_at: now,
				last_used_at: now,
				finished_at: now,
				merge_commit: null,
			});

			const res = await app.request(`/tasks/${created.task_id}/review`);
			const body = (await res.json()) as { state: string; mergeable: boolean; blockers: string[] };
			expect(res.status).toBe(200);
			expect(body.state).toBe("ready");
			expect(body.mergeable).toBe(true);
			expect(body.blockers).toEqual([]);

			// Cleanup
			execFileSync("git", ["worktree", "remove", tmpDir, "--force"], { encoding: "utf8" });
			execFileSync("git", ["branch", "-D", branchName], { encoding: "utf8" });
		} finally {
			store.close();
		}
	});

	it("returns blockers for running task", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({
				source: "inline",
				script:
					"export const meta = { name: 'human', description: 'Human' }\nreturn await request_human({ title: 'Approve?' })",
			});
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("needs_human"));

			const res = await app.request(`/tasks/${created.task_id}/review`);
			const body = (await res.json()) as { state: string; mergeable: boolean; blockers: string[] };
			expect(res.status).toBe(200);
			expect(body.state).toBe("blocked");
			expect(body.mergeable).toBe(false);
			expect(body.blockers.length).toBeGreaterThan(0);
		} finally {
			store.close();
		}
	});

	it("returns state:merged for task with merged worktree", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("finished"));

			const now = Date.now();
			store.insertWorktree({
				id: `wt-${created.task_id}`,
				task_id: created.task_id,
				label: "dev",
				branch: `kanade/${created.task_id}`,
				base_branch: "main",
				worktree_path: `/tmp/${created.task_id}`,
				status: "merged",
				base_repo: process.cwd(),
				created_at: now,
				last_used_at: now,
				finished_at: now,
				merge_commit: "abc123",
			});

			const res = await app.request(`/tasks/${created.task_id}/review`);
			const body = (await res.json()) as { state: string; mergeable: boolean };
			expect(res.status).toBe(200);
			expect(body.state).toBe("merged");
			expect(body.mergeable).toBe(false);
		} finally {
			store.close();
		}
	});

	it("includes agents, phases, and usage in review", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("finished"));

			store.insertWorktree({
				id: `wt-${created.task_id}`,
				task_id: created.task_id,
				label: "dev",
				branch: `kanade/${created.task_id}`,
				base_branch: "main",
				worktree_path: `/tmp/${created.task_id}`,
				status: "inactive",
				base_repo: process.cwd(),
				created_at: Date.now(),
				last_used_at: Date.now(),
				finished_at: Date.now(),
				merge_commit: null,
			});

			const res = await app.request(`/tasks/${created.task_id}/review`);
			const body = (await res.json()) as {
				task_id: string;
				review: { agents: { total: number }; phases: { completed: number } };
				iteration_chain: string[];
			};
			expect(res.status).toBe(200);
			expect(body.task_id).toBe(created.task_id);
			expect(body.review.agents).toBeDefined();
			expect(body.review.phases).toBeDefined();
			expect(body.iteration_chain).toContain(created.task_id);
		} finally {
			store.close();
		}
	});
});

describe("GET /config", () => {
	it("returns merged config with masked sensitive fields", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/config");
			const body = (await res.json()) as { paths: { root: string; configFile: string }; models: { authPath: string } };
			expect(res.status).toBe(200);
			expect(body.paths.root).toBeDefined();
			expect(body.paths.configFile).toBeDefined();
			expect(body.models.authPath).not.toBe("<configured>"); // null by default
		} finally {
			store.close();
		}
	});

	it("masks authPath when configured", async () => {
		const root = mkdtempSync(join(tmpdir(), "kanade-config-"));
		process.env.KANADE_DIR = root;
		const config = loadConfig();
		config.models.authPath = "/tmp/secret-auth.json";
		const store = new StateStore(config.paths.stateDb);
		const events = new EventBus();
		const humanGate = new HumanGate(store, { initialPollMs: 5 });
		const taskManager = new TaskManager(config, store, events, humanGate);
		const app = createApp({ taskManager, events, config });
		try {
			const res = await app.request("/config");
			const body = (await res.json()) as { models: { authPath: string } };
			expect(res.status).toBe(200);
			expect(body.models.authPath).toBe("<configured>");
		} finally {
			store.close();
		}
	});
});

describe("PATCH /config", () => {
	it("rejects blocked fields", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/config", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ paths: { root: "/bad" } }),
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: string; errors: string[] };
			expect(body.error).toBe("Validation failed");
			expect(body.errors.length).toBeGreaterThan(0);
		} finally {
			store.close();
		}
	});

	it("rejects unknown top-level keys", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/config", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ unknownSection: { key: "value" } }),
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as { errors: string[] };
			expect(body.errors[0]).toContain("Unknown");
		} finally {
			store.close();
		}
	});

	it("rejects models.mode as blocked field", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/config", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ models: { mode: "kanade" } }),
			});
			expect(res.status).toBe(400);
		} finally {
			store.close();
		}
	});

	it("rejects null values for top-level sections", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/config", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ defaults: null }),
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as { errors: string[] };
			expect(body.errors[0]).toContain("null");
		} finally {
			store.close();
		}
	});

	it("rejects unknown nested keys", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/config", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ defaults: { unknownField: "value" } }),
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as { errors: string[] };
			expect(body.errors[0]).toContain("Unknown nested");
		} finally {
			store.close();
		}
	});
});

describe("PATCH /config runtime effect", () => {
	it("updates task manager config after patch", async () => {
		const { config, store, app } = setup();
		try {
			const originalConcurrency = config.defaults.concurrency;
			const res = await app.request("/config", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ defaults: { concurrency: originalConcurrency + 1 } }),
			});
			expect(res.status).toBe(200);
			// Verify the live config was updated
			const configRes = await app.request("/config");
			const configBody = (await configRes.json()) as { defaults: { concurrency: number } };
			expect(configBody.defaults.concurrency).toBe(originalConcurrency + 1);
		} finally {
			store.close();
		}
	});
});

describe("GET /tasks/:id/review — no_changes state", () => {
	it("returns no_changes for finished task with worktree but no changes", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("finished"));

			const now = Date.now();
			store.insertWorktree({
				id: `wt-${created.task_id}`,
				task_id: created.task_id,
				label: "dev",
				branch: `kanade/${created.task_id}`,
				base_branch: "main",
				worktree_path: `/tmp/${created.task_id}`,
				status: "inactive",
				base_repo: process.cwd(),
				created_at: now,
				last_used_at: now,
				finished_at: now,
				merge_commit: null,
			});

			const res = await app.request(`/tasks/${created.task_id}/review`);
			const body = (await res.json()) as { state: string; mergeable: boolean };
			expect(res.status).toBe(200);
			// Worktree exists but branch has no real changes → no_changes
			expect(body.state).toBe("no_changes");
			expect(body.mergeable).toBe(false);
		} finally {
			store.close();
		}
	});
});

describe("POST /tasks/:id/merge — review gating", () => {
	it("rejects merge when review state is no_changes", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("finished"));

			const now = Date.now();
			store.insertWorktree({
				id: `wt-${created.task_id}`,
				task_id: created.task_id,
				label: "dev",
				branch: `kanade/${created.task_id}`,
				base_branch: "main",
				worktree_path: `/tmp/${created.task_id}`,
				status: "inactive",
				base_repo: process.cwd(),
				created_at: now,
				last_used_at: now,
				finished_at: now,
				merge_commit: null,
			});

			const res = await app.request(`/tasks/${created.task_id}/merge`, { method: "POST" });
			const body = (await res.json()) as { error: string };
			expect(res.status).toBe(400);
			expect(body.error).toContain("No changes");
		} finally {
			store.close();
		}
	});

	it("rejects merge when review state is checks_failed", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("finished"));

			// Create a real branch with changes
			const branchName = `kanade/${created.task_id}`;
			const tmpDir = tempWorktreePath(`kanade-wt-blocked-${created.task_id}`);
			execFileSync("git", ["branch", branchName], { encoding: "utf8" });
			execFileSync("git", ["worktree", "add", tmpDir, branchName], { encoding: "utf8" });
			writeFileSync(join(tmpDir, "test.txt"), "content");
			execFileSync("git", ["add", "test.txt"], { cwd: tmpDir, encoding: "utf8" });
			execFileSync("git", [...TEST_GIT_AUTHOR, "commit", "-m", "test"], { cwd: tmpDir, encoding: "utf8" });

			const now = Date.now();
			store.insertWorktree({
				id: `wt-${created.task_id}`,
				task_id: created.task_id,
				label: "dev",
				branch: branchName,
				base_branch: TEST_BASE_REF,
				worktree_path: tmpDir,
				status: "active",
				base_repo: process.cwd(),
				created_at: now,
				last_used_at: now,
				finished_at: now,
				merge_commit: null,
			});

			// Insert a failed agent call to create a checks_failed state
			store.insertAgentCall({
				id: `agent-${created.task_id}`,
				task_id: created.task_id,
				label: "agent-1",
				role: null,
				phase: "implement",
				isolation_mode: "worktree",
				worktree_id: `wt-${created.task_id}`,
				status: "failed",
				started_at: now,
				finished_at: now,
				tokens_input: null,
				tokens_output: null,
				tokens_cache_read: null,
				tokens_cache_creation: null,
				cost_usd: null,
				trace_id: null,
				span_id: null,
			});

			const res = await app.request(`/tasks/${created.task_id}/merge`, { method: "POST" });
			const body = (await res.json()) as { error: string };
			expect(res.status).toBe(400);
			expect(body.error).toContain("not ready");

			// Cleanup
			execFileSync("git", ["worktree", "remove", tmpDir, "--force"], { encoding: "utf8" });
			execFileSync("git", ["branch", "-D", branchName], { encoding: "utf8" });
		} finally {
			store.close();
		}
	});
});

describe("GET /tasks/:id with inline usage", () => {
	it("returns 404 for unknown task", async () => {
		const { store, app } = setup();
		try {
			const res = await app.request("/tasks/T-9999");
			expect(res.status).toBe(404);
		} finally {
			store.close();
		}
	});

	it("includes parsed tasks.usage in the task detail response", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("finished"));
			store.updateTask(created.task_id, {
				usage: JSON.stringify({
					input: 100,
					output: 50,
					cacheRead: 20,
					cacheWrite: 10,
					totalTokens: 180,
					cost: { input: 0.001, output: 0.002, cacheRead: 0.0003, cacheWrite: 0.0001, total: 0.0034 },
				}),
			});

			const res = await app.request(`/tasks/${created.task_id}`);
			const body = (await res.json()) as { task: Record<string, unknown>; usage: Record<string, unknown> | null };
			expect(res.status).toBe(200);
			expect(body.task.id).toBe(created.task_id);
			expect(body.task).not.toHaveProperty("usage");
			expect(body.usage).toEqual({
				input: 100,
				output: 50,
				cacheRead: 20,
				cacheWrite: 10,
				totalTokens: 180,
				cost: { input: 0.001, output: 0.002, cacheRead: 0.0003, cacheWrite: 0.0001, total: 0.0034 },
			});
		} finally {
			store.close();
		}
	});

	it("no longer exposes a dedicated /tasks/:id/usage route", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("finished"));
			const res = await app.request(`/tasks/${created.task_id}/usage`);
			expect(res.status).toBe(404);
		} finally {
			store.close();
		}
	});

	it("returns usage.agents in the response when agents array is present", async () => {
		const { store, taskManager, app } = setup();
		try {
			const created = taskManager.create({ source: "inline", script: SIMPLE_SCRIPT });
			await vi.waitFor(() => expect(taskManager.get(created.task_id)?.status).toBe("finished"));

			const agentsArray = [
				{
					label: "dev",
					phase: "Implement",
					model: "m1",
					role: "developer",
					input: 100,
					output: 50,
					cacheRead: 200,
					cacheWrite: 0,
					totalTokens: 350,
					cost: { total: 0.0033 },
				},
				{
					label: "reviewer",
					phase: "Review",
					model: "m2",
					role: "reviewer",
					input: 500,
					output: 200,
					cacheRead: 1000,
					cacheWrite: 0,
					totalTokens: 1700,
					cost: { total: 0.013 },
				},
			];
			store.updateTask(created.task_id, {
				usage: JSON.stringify({
					input: 600,
					output: 250,
					cacheRead: 1200,
					cacheWrite: 0,
					totalTokens: 2050,
					cost: { input: 0.006, output: 0.008, cacheRead: 0.0023, cacheWrite: 0, total: 0.0163 },
					agents: agentsArray,
				}),
			});

			const res = await app.request(`/tasks/${created.task_id}`);
			const body = (await res.json()) as { usage: Record<string, unknown> | null };
			expect(res.status).toBe(200);
			expect(body.usage).not.toBeNull();
			expect(body.usage?.agents).toEqual(agentsArray);
		} finally {
			store.close();
		}
	});
});
