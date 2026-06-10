import { execSync } from "node:child_process";
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
	prepareCommands?: string[];
}

export interface MergeResult {
	success: boolean;
	mergeCommit?: string;
	error?: string;
	conflicts?: string[];
}

export interface PrepareOptions {
	taskId: string;
	label: string;
	mode: IsolationMode;
	baseRepo?: string;
	baseBranch?: string;
	reuseBranch?: string;
}

export interface PrepareWithCommandsOptions extends PrepareOptions {
	commands?: string[];
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

	/**
	 * Prepare the task worktree and execute shell commands in it.
	 * Returns early with no worktree side-effects if no commands are provided.
	 */
	async prepareWithCommands(opts: PrepareWithCommandsOptions): Promise<IsolationContext> {
		const commands = this.normalizePrepareCommands(opts.commands);
		if (opts.mode !== "worktree" || commands.length === 0) {
			const cwd = opts.baseRepo ?? this.config.defaultBaseRepo ?? process.cwd();
			return { cwd, cleanup: async () => {} };
		}

		const context = await this.prepareWorktree(opts);
		for (const command of commands) {
			try {
				execSync(command, {
					shell: true,
					cwd: context.cwd,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (error) {
				const status =
					(error as { status?: number }).status ??
					(error instanceof Error && (error as { code?: number }).code ? (error as { code?: number }).code : undefined);
				const stdout = this.toCommandOutput((error as { stdout?: unknown }).stdout);
				const stderr = this.toCommandOutput((error as { stderr?: unknown }).stderr);
				await context.cleanup().catch(() => {});
				throw new Error(
					`Failed to run worktree preparation command:\n${command}\nExit code: ${String(status)}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
				);
			}
		}
		return context;
	}

	/**
	 * Finalize worktrees after task completion.
	 *
	 * IMPORTANT: "approved" never deletes the worktree. The user must explicitly
	 * call merge() or reject() to decide the worktree's fate.
	 *
	 * - approved: mark inactive (keep dir + branch for inspection/merge)
	 * - rejected + autoCleanupOnReject: remove dir + branch
	 * - aborted + autoCleanupOnAbort: remove dir + branch
	 * - rejected/aborted without cleanup: mark status only
	 */
	async finalizeWorktrees(taskId: string, decision: "approved" | "rejected" | "aborted"): Promise<void> {
		const rows = this.store.findWorktreesByTask(taskId);
		for (const row of rows) {
			if (decision === "rejected" && (this.config.autoCleanupOnReject ?? true)) {
				await this.removeWorktree(row);
				this.store.updateWorktree(row.id, { status: "rejected", finished_at: Date.now() });
			} else if (decision === "aborted" && (this.config.autoCleanupOnAbort ?? true)) {
				await this.removeWorktree(row);
				this.store.updateWorktree(row.id, { status: "abandoned", finished_at: Date.now() });
			} else if (decision === "approved") {
				// NEVER delete worktree on approval. User must explicitly merge or reject.
				this.store.updateWorktree(row.id, { status: "inactive", finished_at: Date.now() });
			} else {
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
	 * Merge a task's worktree branch into the configured target branch.
	 *
	 * SAFETY: worktree is only deleted on successful merge. On failure, the
	 * worktree and branch are preserved so the user can inspect/fix manually.
	 *
	 * Steps:
	 * 1. Validate worktree dir and branch exist
	 * 2. Commit dirty worktree changes
	 * 3. Checkout target branch in base repo
	 * 4. git merge --no-ff <branch>
	 * 5. On success: delete worktree dir + branch (if configured)
	 * 6. On failure: restore original branch, preserve worktree
	 */
	async merge(taskId: string): Promise<MergeResult> {
		const rows = this.store.findWorktreesByTask(taskId);
		if (rows.length === 0) return { success: false, error: `No worktrees found for task: ${taskId}` };

		const target = this.mergeConfig?.targetBranch ?? this.config.defaultBaseBranch;
		const useNoFf = this.mergeConfig?.useNoFf ?? true;
		const baseRepo = rows[0].base_repo;
		const git = simpleGit(baseRepo);
		const currentBranch = (await git.branchLocal()).current;

		try {
			// 1. Validate worktree integrity
			for (const row of rows) {
				if (!existsSync(row.worktree_path)) {
					return { success: false, error: `Worktree directory missing: ${row.worktree_path}` };
				}
				const branches = await git.branchLocal();
				if (!branches.all.includes(row.branch)) {
					return { success: false, error: `Branch ${row.branch} not found in ${baseRepo}` };
				}
			}

			// 2. Commit dirty worktree changes
			for (const row of rows) {
				await this.commitDirtyWorktree(row);
			}

			// 3. Checkout target
			await git.checkoutLocalBranch(target).catch(() => git.checkout(target));

			// 4. Merge each branch
			for (const row of rows) {
				const mergeArgs = useNoFf ? ["merge", "--no-ff", row.branch] : ["merge", row.branch];
				try {
					await git.raw(mergeArgs);
				} catch (mergeErr) {
					// Merge failed — check if it's a conflict
					await git.raw(["merge", "--abort"]).catch(() => {});
					await git.checkout(currentBranch).catch(() => {});
					const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
					return {
						success: false,
						error: `Merge conflict for ${row.branch}: ${msg}`,
						conflicts: [msg],
					};
				}
				// Verify merge didn't leave unresolved conflicts
				const status = await git.status();
				if (status.conflicted.length > 0) {
					await git.raw(["merge", "--abort"]).catch(() => {});
					await git.checkout(currentBranch).catch(() => {});
					return {
						success: false,
						error: `Merge conflict in: ${status.conflicted.join(", ")}`,
						conflicts: status.conflicted,
					};
				}
			}

			// 5. Run lint guard
			if (this.mergeConfig?.requireCleanLint) {
				try {
					const { execSync } = await import("node:child_process");
					execSync("npm run lint", { cwd: baseRepo, stdio: "pipe" });
				} catch {
					await git.raw(["reset", "--hard", "HEAD~1"]);
					return { success: false, error: "Lint check failed. Merge rolled back." };
				}
			}

			// 6. Run test guard
			if (this.mergeConfig?.requireCleanTest) {
				try {
					const { execSync } = await import("node:child_process");
					execSync("npm test -- --run", { cwd: baseRepo, stdio: "pipe" });
				} catch {
					await git.raw(["reset", "--hard", "HEAD~1"]);
					return { success: false, error: "Test check failed. Merge rolled back." };
				}
			}

			// 7. Success: get merge commit hash
			const log = await git.log({ maxCount: 1 });
			const mergeCommit = log.latest?.hash ?? "";

			// 8. Update worktree status and cleanup
			for (const row of rows) {
				this.store.updateWorktree(row.id, {
					status: "merged",
					merge_commit: mergeCommit,
					finished_at: Date.now(),
				});

				// Delete worktree dir ONLY on success
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
			// SAFETY: On failure, restore original branch. NEVER delete worktree.
			try {
				await git.checkout(currentBranch);
			} catch {
				// best effort
			}

			const msg = err instanceof Error ? err.message : String(err);
			const isConflict = /CONFLICT|merge.*fail|cannot be merged|not something we can merge/i.test(msg);

			if (isConflict) {
				return {
					success: false,
					error: `Merge conflict. Resolve conflicts manually in ${baseRepo}, then run: kanade merge ${taskId}`,
					conflicts: [msg],
				};
			}

			return { success: false, error: msg };
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

	private normalizePrepareCommands(commands?: string[]): string[] {
		if (!Array.isArray(commands)) return [];
		return commands.filter((command): command is string => typeof command === "string" && command.trim().length > 0);
	}

	private toCommandOutput(value: unknown): string {
		if (typeof value === "string") return value.trim();
		if (Buffer.isBuffer(value)) return value.toString("utf8").trim();
		return "";
	}

	private async prepareWorktree(opts: PrepareOptions): Promise<IsolationContext> {
		const baseRepo = opts.baseRepo ?? this.config.defaultBaseRepo ?? process.cwd();
		// If no explicit baseBranch, use the current branch of the base repo, falling back to config default
		let baseBranch: string = opts.baseBranch ?? "";
		if (!baseBranch) {
			try {
				const git = simpleGit(baseRepo);
				baseBranch = (await git.branchLocal()).current || this.config.defaultBaseBranch;
			} catch {
				baseBranch = this.config.defaultBaseBranch;
			}
		}
		if (!baseBranch) {
			baseBranch = this.config.defaultBaseBranch;
		}

		// Reuse existing task-scoped worktree by default so phases/agents can hand off code changes.
		const existingForTask = this.store
			.findWorktreesByTask(opts.taskId)
			.find((row) => (row.status === "active" || row.status === "inactive") && existsSync(row.worktree_path));
		if (existingForTask) {
			this.store.updateWorktree(existingForTask.id, { status: "active", last_used_at: Date.now() });
			return this.makeContext(existingForTask);
		}

		// Explicit branch reuse is kept for callers that want to attach to an existing task branch.
		if (opts.reuseBranch) {
			const existing = this.store.findWorktreeByBranch(opts.taskId, opts.reuseBranch);
			if (existing && existsSync(existing.worktree_path)) {
				this.store.updateWorktree(existing.id, { status: "active", last_used_at: Date.now() });
				return this.makeContext(existing);
			}
		}

		const branch = `${this.config.branchPrefix}/${opts.taskId}`;
		const worktreeBaseDir = this.config.worktreeBaseDir ?? join(baseRepo, "..");
		const worktreePath = join(worktreeBaseDir, opts.taskId);
		mkdirSync(worktreeBaseDir, { recursive: true });

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

	/** Commit dirty changes in a worktree. Safe to call multiple times. Returns true when a commit was created. */
	async commitDirtyWorktree(rowOrPath: WorktreeRow | string, label?: string): Promise<boolean> {
		const worktreePath = typeof rowOrPath === "string" ? rowOrPath : rowOrPath.worktree_path;
		const taskLabel = typeof rowOrPath === "string" ? "" : rowOrPath.task_id;
		const agentLabel = label ?? (typeof rowOrPath === "string" ? "" : rowOrPath.label);
		if (!existsSync(worktreePath)) return false;
		const git = simpleGit(worktreePath);
		const status = await git.status();
		if (status.isClean()) return false;
		await git.add(".");
		await git.commit(`kanade: save ${taskLabel} ${agentLabel} changes`);
		return true;
	}

	private async removeWorktree(row: WorktreeRow): Promise<void> {
		await this.removeWorktreeDir(row);
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
