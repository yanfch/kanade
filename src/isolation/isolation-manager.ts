import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
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
	branchPrefix: string;
	autoCleanupOnReject?: boolean;
	autoCleanupOnApprove?: boolean;
	autoCleanupOnAbort?: boolean;
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
	) {}

	async prepare(opts: PrepareOptions): Promise<IsolationContext> {
		if (opts.mode === "none") {
			const cwd = opts.baseRepo ?? process.cwd();
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

	// ── private ──────────────────────────────────────────────────────────────

	private async prepareWorktree(opts: PrepareOptions): Promise<IsolationContext> {
		const baseRepo = opts.baseRepo ?? process.cwd();
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
		const worktreePath = join(baseRepo, "..", `${opts.taskId}-worktrees`, opts.label);
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
