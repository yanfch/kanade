import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import type { MergeConfig } from "../config/index.ts";
import type { StateStore, WorktreeRow } from "../store/index.ts";

export type IsolationMode = "none" | "worktree";

export interface WorktreeRef {
	id: string;
	branch: string;
	path: string;
}

export interface IsolationContext {
	cwd: string;
	worktree?: WorktreeRef;
	cleanup(): Promise<void>;
}

export interface IsolationConfig {
	defaultBaseBranch: string;
	defaultBaseRepo?: string | null;
	worktreeBaseDir?: string;
	branchPrefix: string;
	autoCleanupOnReject?: boolean;
	autoCleanupOnApprove?: boolean;
	autoCleanupOnAbort?: boolean;
}

export interface MergeResult {
	success: boolean;
	mergeCommit?: string;
	error?: string;
}

export interface PrepareOptions {
	taskId: string;
	label: string;
	mode: IsolationMode;
	baseRepo?: string;
	baseBranch?: string;
	reuseBranch?: string;
}

function generateId(): string {
	return `wt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export class IsolationManager {
	constructor(
		private readonly store: StateStore,
		private readonly config: IsolationConfig,
		private readonly mergeConfig?: MergeConfig,
	) {}

	async prepare(opts: PrepareOptions): Promise<IsolationContext> {
		if (opts.mode === "none") {
			const cwd = opts.baseRepo ?? this.config.defaultBaseRepo ?? process.cwd();
			return { cwd, cleanup: async () => {} };
		}
		return this.prepareWorktree(opts);
	}

	async finalizeWorktrees(taskId: string, decision: "approved" | "rejected" | "aborted"): Promise<void> {
		const rows = this.store.findWorktreesByTask(taskId);
		for (const row of rows) {
			if (decision === "rejected" && (this.config.autoCleanupOnReject ?? true)) {
				// rejected + cleanup enabled: remove worktree dir + branch
				await this.removeWorktree(row);
				this.store.updateWorktree(row.id, { status: "rejected", finished_at: Date.now() });
			} else if (decision === "aborted" && (this.config.autoCleanupOnAbort ?? true)) {
				// aborted + cleanup enabled: remove worktree dir + branch
				await this.removeWorktree(row);
				this.store.updateWorktree(row.id, { status: "abandoned", finished_at: Date.now() });
			} else if (decision === "approved") {
				// approved: remove worktree dir to save disk, keep branch for merge
				await this.removeWorktreeDir(row);
				this.store.updateWorktree(row.id, { status: "inactive", finished_at: Date.now() });
			} else {
				// rejected/aborted with cleanup disabled: keep everything
				this.store.updateWorktree(row.id, {
					status: decision === "rejected" ? "rejected" : "abandoned",
					finished_at: Date.now(),
				});
			}
		}
	}

	async cleanupStaleWorktrees(beforeTs: number): Promise<void> {
		const rows = this.store.findStaleWorktrees(beforeTs);
		for (const row of rows) {
			await this.removeWorktree(row);
			this.store.updateWorktree(row.id, { status: "abandoned", finished_at: Date.now() });
		}
	}

	/**
	 * Merge a task's worktree branch into the target branch (typically develop).
	 *
	 * Steps:
	 * 1. Checkout target branch
	 * 2. git merge --no-ff <branch>
	 * 3. Run lint + test guards (if configured)
	 * 4. On success: delete worktree dir + branch (if configured)
	 * 5. On failure: git reset --hard to undo the merge
	 */
	async merge(taskId: string): Promise<MergeResult> {
		const rows = this.store.findWorktreesByTask(taskId);
		if (rows.length === 0) return { success: false, error: `No worktrees found for task: ${taskId}` };

		const target = this.mergeConfig?.targetBranch ?? this.config.defaultBaseBranch;
		const useNoFf = this.mergeConfig?.useNoFf ?? true;

		// Use the first worktree's base_repo
		const baseRepo = rows[0].base_repo;
		const git = simpleGit(baseRepo);

		// Save current branch to restore on failure
		const currentBranch = (await git.branchLocal()).current;

		try {
			// 1. Checkout target
			await git.checkoutLocalBranch(target).catch(() => git.checkout(target));

			// 2. Merge each branch
			for (const row of rows) {
				const mergeArgs = useNoFf ? ["merge", "--no-ff", row.branch] : ["merge", row.branch];
				await git.raw(mergeArgs);
			}

			// 3. Run lint guard
			if (this.mergeConfig?.requireCleanLint) {
				try {
					const { execSync } = await import("node:child_process");
					execSync("npm run lint", { cwd: baseRepo, stdio: "pipe" });
				} catch {
					await git.raw(["reset", "--hard", "HEAD~1"]);
					return { success: false, error: "Lint check failed. Merge rolled back." };
				}
			}

			// 4. Run test guard
			if (this.mergeConfig?.requireCleanTest) {
				try {
					const { execSync } = await import("node:child_process");
					execSync("npm test -- --run", { cwd: baseRepo, stdio: "pipe" });
				} catch {
					await git.raw(["reset", "--hard", "HEAD~1"]);
					return { success: false, error: "Test check failed. Merge rolled back." };
				}
			}

			// 5. Get merge commit hash
			const log = await git.log({ maxCount: 1 });
			const mergeCommit = log.latest?.hash ?? "";

			// 6. Update worktree status
			for (const row of rows) {
				this.store.updateWorktree(row.id, {
					status: "merged",
					merge_commit: mergeCommit,
					finished_at: Date.now(),
				});

				// Delete worktree dir
				await this.removeWorktreeDir(row);

				// Delete branch if configured
				if (this.mergeConfig?.deleteBranchAfterMerge ?? true) {
					try {
						await git.deleteLocalBranch(row.branch, true);
					} catch {
						// branch may already be gone
					}
				}
			}

			return { success: true, mergeCommit };
		} catch (err) {
			// Rollback: reset to the state before merge
			try {
				await git.raw(["reset", "--hard", "HEAD~1"]);
			} catch {
				// reset may fail if merge didn't actually happen
			}

			// Restore original branch
			try {
				await git.checkout(currentBranch);
			} catch {
				// best effort
			}

			return {
				success: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	/**
	 * Reject a task: remove worktree + branch without merging.
	 */
	async reject(taskId: string): Promise<void> {
		const rows = this.store.findWorktreesByTask(taskId);
		for (const row of rows) {
			await this.removeWorktree(row);
			this.store.updateWorktree(row.id, { status: "rejected", finished_at: Date.now() });
		}
	}

	// ── private ──────────────────────────────────────────────────────────────

	private async prepareWorktree(opts: PrepareOptions): Promise<IsolationContext> {
		const baseRepo = opts.baseRepo ?? this.config.defaultBaseRepo ?? process.cwd();
		const baseBranch = opts.baseBranch ?? this.config.defaultBaseBranch;

		// Reuse existing worktree?
		if (opts.reuseBranch) {
			const existing = this.store.findWorktreeByBranch(opts.taskId, opts.reuseBranch);
			if (existing && existsSync(existing.worktree_path)) {
				this.store.updateWorktree(existing.id, { status: "active", last_used_at: Date.now() });
				return this.makeContext(existing);
			}
		}

		const branch = `${this.config.branchPrefix}/${opts.taskId}/${opts.label}`;
		const worktreeBaseDir = this.config.worktreeBaseDir ?? join(baseRepo, "..");
		const worktreePath = join(worktreeBaseDir, `${opts.taskId}-worktrees`, opts.label);
		mkdirSync(join(worktreePath, ".."), { recursive: true });

		const git = simpleGit(baseRepo);
		await git.raw(["worktree", "add", "-b", branch, worktreePath, baseBranch]);

		const id = generateId();
		const now = Date.now();
		const row: WorktreeRow = {
			id,
			task_id: opts.taskId,
			label: opts.label,
			branch,
			base_branch: baseBranch,
			worktree_path: worktreePath,
			status: "active",
			base_repo: baseRepo,
			created_at: now,
			last_used_at: now,
			finished_at: null,
			merge_commit: null,
		};
		this.store.insertWorktree(row);

		return this.makeContext(row);
	}

	private makeContext(row: WorktreeRow): IsolationContext {
		const ref: WorktreeRef = { id: row.id, branch: row.branch, path: row.worktree_path };
		return {
			cwd: row.worktree_path,
			worktree: ref,
			cleanup: async () => {
				this.store.updateWorktree(row.id, { status: "inactive", last_used_at: Date.now() });
			},
		};
	}

	private async removeWorktree(row: WorktreeRow): Promise<void> {
		await this.removeWorktreeDir(row);
		// delete branch
		try {
			const git = simpleGit(row.base_repo);
			await git.deleteLocalBranch(row.branch, true);
		} catch {
			// branch may already be gone
		}
	}

	private async removeWorktreeDir(row: WorktreeRow): Promise<void> {
		try {
			const git = simpleGit(row.base_repo);
			await git.raw(["worktree", "remove", row.worktree_path, "--force"]);
		} catch {
			// worktree may already be removed
		}
		if (existsSync(row.worktree_path)) {
			rmSync(row.worktree_path, { recursive: true, force: true });
		}
	}
}
