import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../store/index.ts";
import { IsolationManager } from "./isolation-manager.ts";

const DUMMY_TASK_ID = "T-0001";

async function makeRepo(): Promise<{ baseRepo: string; store: StateStore }> {
	const root = mkdtempSync(join(tmpdir(), "kanade-iso-"));
	const baseRepo = join(root, "repo");
	const stateDb = join(root, "state.db");

	mkdirSync(baseRepo, { recursive: true });
	await simpleGit(baseRepo).init();
	const lg = simpleGit(baseRepo);
	await lg.addConfig("user.email", "test@kanade");
	await lg.addConfig("user.name", "kanade-test");
	writeFileSync(join(baseRepo, "README.md"), "init");
	await lg.add(".");
	await lg.commit("init");
	await lg.checkoutLocalBranch("develop");

	const store = new StateStore(stateDb);
	// worktrees FK requires a task row
	store.insertTask({
		id: DUMMY_TASK_ID,
		workflow_source: "inline",
		workflow_name: null,
		workflow_path: "/tmp/wf.js",
		status: "running",
		base_repo: baseRepo,
		base_branch: "develop",
		cwd: baseRepo,
		created_at: Date.now(),
		started_at: Date.now(),
		finished_at: null,
		error: null,
		options: "{}",
		result: null,
	});
	return { baseRepo, store };
}

describe("IsolationManager — mode:none", () => {
	let store: StateStore;

	beforeEach(() => {
		const root = mkdtempSync(join(tmpdir(), "kanade-iso-none-"));
		store = new StateStore(join(root, "state.db"));
	});
	afterEach(() => store?.close());

	it("returns process.cwd() when no baseRepo given", async () => {
		const mgr = new IsolationManager(store, { defaultBaseBranch: "develop", branchPrefix: "kanade" });
		const ctx = await mgr.prepare({ taskId: "T-0001", label: "agent", mode: "none" });
		expect(ctx.cwd).toBe(process.cwd());
		expect(ctx.worktree).toBeUndefined();
		await ctx.cleanup();
	});

	it("returns baseRepo as cwd when provided", async () => {
		const mgr = new IsolationManager(store, { defaultBaseBranch: "develop", branchPrefix: "kanade" });
		const ctx = await mgr.prepare({ taskId: "T-0001", label: "agent", mode: "none", baseRepo: "/tmp" });
		expect(ctx.cwd).toBe("/tmp");
		await ctx.cleanup();
	});
});

describe("IsolationManager — mode:worktree", () => {
	let baseRepo: string;
	let store: StateStore;

	beforeEach(async () => {
		({ baseRepo, store } = await makeRepo());
	});
	afterEach(() => store?.close());

	it("creates a worktree on a new branch", async () => {
		const mgr = new IsolationManager(store, { defaultBaseBranch: "develop", branchPrefix: "kanade" });
		const ctx = await mgr.prepare({ taskId: "T-0001", label: "dev", mode: "worktree", baseRepo });

		expect(ctx.cwd).toContain("T-0001");
		expect(ctx.worktree).toBeDefined();
		expect(ctx.worktree!.branch).toBe("kanade/T-0001/dev");

		const row = store.getWorktree(ctx.worktree!.id);
		expect(row?.status).toBe("active");
		expect(row?.branch).toBe("kanade/T-0001/dev");

		await ctx.cleanup();
	});

	it("marks worktree inactive on cleanup", async () => {
		const mgr = new IsolationManager(store, { defaultBaseBranch: "develop", branchPrefix: "kanade" });
		const ctx = await mgr.prepare({ taskId: "T-0001", label: "dev", mode: "worktree", baseRepo });
		const id = ctx.worktree!.id;

		await ctx.cleanup();
		expect(store.getWorktree(id)?.status).toBe("inactive");
	});

	it("reuses an existing worktree when reuseBranch matches", async () => {
		const mgr = new IsolationManager(store, { defaultBaseBranch: "develop", branchPrefix: "kanade" });

		const first = await mgr.prepare({ taskId: "T-0001", label: "dev", mode: "worktree", baseRepo });
		await first.cleanup();

		const second = await mgr.prepare({
			taskId: "T-0001",
			label: "dev-iter-2",
			mode: "worktree",
			baseRepo,
			reuseBranch: "kanade/T-0001/dev",
		});

		expect(second.worktree!.id).toBe(first.worktree!.id);
		expect(second.cwd).toBe(first.cwd);
		expect(store.getWorktree(first.worktree!.id)?.status).toBe("active");

		await second.cleanup();
	});

	it("finalizeWorktrees approved: removes worktree dir but keeps branch", async () => {
		const mgr = new IsolationManager(store, {
			defaultBaseBranch: "develop",
			branchPrefix: "kanade",
			autoCleanupOnApprove: false,
		});
		const ctx = await mgr.prepare({ taskId: "T-0001", label: "dev", mode: "worktree", baseRepo });
		await ctx.cleanup();

		await mgr.finalizeWorktrees("T-0001", "approved");

		const row = store.getWorktree(ctx.worktree!.id);
		expect(row?.status).toBe("inactive");

		const branches = await simpleGit(baseRepo).branchLocal();
		expect(branches.all).toContain("kanade/T-0001/dev");
	});

	it("finalizeWorktrees rejected: removes worktree dir and branch", async () => {
		const mgr = new IsolationManager(store, {
			defaultBaseBranch: "develop",
			branchPrefix: "kanade",
			autoCleanupOnReject: true,
		});
		const ctx = await mgr.prepare({ taskId: "T-0001", label: "dev", mode: "worktree", baseRepo });
		await ctx.cleanup();

		await mgr.finalizeWorktrees("T-0001", "rejected");

		const row = store.getWorktree(ctx.worktree!.id);
		expect(row?.status).toBe("rejected");

		const branches = await simpleGit(baseRepo).branchLocal();
		expect(branches.all).not.toContain("kanade/T-0001/dev");
	});

	it("finalizeWorktrees aborted: removes worktree dir and branch", async () => {
		const mgr = new IsolationManager(store, {
			defaultBaseBranch: "develop",
			branchPrefix: "kanade",
			autoCleanupOnAbort: true,
		});
		const ctx = await mgr.prepare({ taskId: "T-0001", label: "dev", mode: "worktree", baseRepo });
		await ctx.cleanup();

		await mgr.finalizeWorktrees("T-0001", "aborted");

		const row = store.getWorktree(ctx.worktree!.id);
		expect(row?.status).toBe("abandoned");

		const branches = await simpleGit(baseRepo).branchLocal();
		expect(branches.all).not.toContain("kanade/T-0001/dev");
	});

	it("finalizeWorktrees aborted with autoCleanupOnAbort=false keeps branch", async () => {
		const mgr = new IsolationManager(store, {
			defaultBaseBranch: "develop",
			branchPrefix: "kanade",
			autoCleanupOnAbort: false,
		});
		const ctx = await mgr.prepare({ taskId: "T-0001", label: "dev", mode: "worktree", baseRepo });
		await ctx.cleanup();

		await mgr.finalizeWorktrees("T-0001", "aborted");

		const row = store.getWorktree(ctx.worktree!.id);
		// When cleanup is disabled, the else branch runs: removes worktree dir, sets inactive
		// (Note: this is the current behavior — the else branch always removes worktree dir)
		expect(row?.status).toBe("inactive");

		const branches = await simpleGit(baseRepo).branchLocal();
		expect(branches.all).toContain("kanade/T-0001/dev");
	});

	it("finalizeWorktrees with no worktrees is a no-op", async () => {
		const mgr = new IsolationManager(store, {
			defaultBaseBranch: "develop",
			branchPrefix: "kanade",
		});
		// No worktrees created for T-9999
		await mgr.finalizeWorktrees("T-9999", "approved");
		// Should not throw
	});
});

describe("IsolationManager — cleanupStaleWorktrees", () => {
	let baseRepo: string;
	let store: StateStore;

	beforeEach(async () => {
		({ baseRepo, store } = await makeRepo());
	});
	afterEach(() => store?.close());

	it("removes worktrees older than the given timestamp", async () => {
		const mgr = new IsolationManager(store, {
			defaultBaseBranch: "develop",
			branchPrefix: "kanade",
		});
		const ctx = await mgr.prepare({ taskId: "T-0001", label: "dev", mode: "worktree", baseRepo });
		const wtId = ctx.worktree!.id;
		await ctx.cleanup(); // marks inactive

		// Stale threshold: now + 1 hour (all worktrees are older)
		const futureTs = Date.now() + 3600_000;
		await mgr.cleanupStaleWorktrees(futureTs);

		const row = store.getWorktree(wtId);
		expect(row?.status).toBe("abandoned");

		const branches = await simpleGit(baseRepo).branchLocal();
		expect(branches.all).not.toContain("kanade/T-0001/dev");
	});

	it("does not remove worktrees newer than the threshold", async () => {
		const mgr = new IsolationManager(store, {
			defaultBaseBranch: "develop",
			branchPrefix: "kanade",
		});
		const ctx = await mgr.prepare({ taskId: "T-0001", label: "dev", mode: "worktree", baseRepo });
		const wtId = ctx.worktree!.id;
		await ctx.cleanup();

		// Stale threshold: 1 hour ago (no worktrees are old enough)
		const pastTs = Date.now() - 3600_000;
		await mgr.cleanupStaleWorktrees(pastTs);

		const row = store.getWorktree(wtId);
		expect(row?.status).toBe("inactive");

		const branches = await simpleGit(baseRepo).branchLocal();
		expect(branches.all).toContain("kanade/T-0001/dev");
	});

	it("is a no-op when no stale worktrees exist", async () => {
		const mgr = new IsolationManager(store, {
			defaultBaseBranch: "develop",
			branchPrefix: "kanade",
		});
		const futureTs = Date.now() + 3600_000;
		await mgr.cleanupStaleWorktrees(futureTs);
		// Should not throw
	});
});

describe("IsolationManager — reuse edge cases", () => {
	let baseRepo: string;
	let store: StateStore;

	beforeEach(async () => {
		({ baseRepo, store } = await makeRepo());
	});
	afterEach(() => store?.close());

	it("creates a new worktree when reuseBranch does not match any existing worktree", async () => {
		const mgr = new IsolationManager(store, {
			defaultBaseBranch: "develop",
			branchPrefix: "kanade",
		});
		const ctx = await mgr.prepare({
			taskId: "T-0001",
			label: "dev",
			mode: "worktree",
			baseRepo,
			reuseBranch: "kanade/T-0001/nonexistent",
		});

		expect(ctx.worktree).toBeDefined();
		expect(ctx.worktree!.branch).toBe("kanade/T-0001/dev");

		await ctx.cleanup();
	});

	it("creates unique branch names for different labels", async () => {
		const mgr = new IsolationManager(store, {
			defaultBaseBranch: "develop",
			branchPrefix: "kanade",
		});
		const ctx1 = await mgr.prepare({ taskId: "T-0001", label: "dev", mode: "worktree", baseRepo });
		const ctx2 = await mgr.prepare({ taskId: "T-0001", label: "review", mode: "worktree", baseRepo });

		expect(ctx1.worktree!.branch).toBe("kanade/T-0001/dev");
		expect(ctx2.worktree!.branch).toBe("kanade/T-0001/review");
		expect(ctx1.worktree!.id).not.toBe(ctx2.worktree!.id);

		await ctx1.cleanup();
		await ctx2.cleanup();
	});

	it("creates unique branch names for different tasks", async () => {
		// Insert a second task row to satisfy FK constraint
		store.insertTask({
			id: "T-0002",
			workflow_source: "inline",
			workflow_name: null,
			workflow_path: "/tmp/wf.js",
			status: "running",
			base_repo: baseRepo,
			base_branch: "develop",
			cwd: baseRepo,
			created_at: Date.now(),
			started_at: Date.now(),
			finished_at: null,
			error: null,
			options: "{}",
			result: null,
		});
		const mgr = new IsolationManager(store, {
			defaultBaseBranch: "develop",
			branchPrefix: "kanade",
		});
		const ctx1 = await mgr.prepare({ taskId: "T-0001", label: "dev", mode: "worktree", baseRepo });
		const ctx2 = await mgr.prepare({ taskId: "T-0002", label: "dev", mode: "worktree", baseRepo });

		expect(ctx1.worktree!.branch).toBe("kanade/T-0001/dev");
		expect(ctx2.worktree!.branch).toBe("kanade/T-0002/dev");

		await ctx1.cleanup();
		await ctx2.cleanup();
	});
});
