# isolation

`IsolationManager` — git worktree lifecycle for agent calls.

## What goes here

See `docs/10-isolation.md`. The full flow + state machine + cleanup logic is documented there.

Files to add:

- `isolation-manager.ts` — `IsolationManager` class:
  - `prepare(opts)` → returns `IsolationContext { cwd, worktree?, cleanup }`
  - Creates worktrees via `simple-git` or spawning `git worktree add`
  - Reuses existing worktree when `reuseBranch` matches an active row in StateStore
  - `releaseWorktree(id)` marks `inactive` after agent call ends
  - `finalizeWorktrees(taskId, decision)` decides keep/cleanup per config
  - `cleanupStaleWorktrees()` removes worktrees idle > N days
  - Branch naming: `{branchPrefix}/{task_id}/{label}` (default `kanade/T-xxx/dev`)
- `git-helpers.ts` — Thin wrappers: `ensureBranch`, `worktreeAdd`, `worktreeRemove`, `branchDelete`, `mergeBranch`. Use `simple-git` or spawn `git`.
- `merge.ts` — `mergeWorktreeToBase(taskId)`: checks out base branch, merges with `--no-ff`, runs lint/test guards from config, deletes branch on success.
- `index.ts` — Re-exports.

## Constraints

- Never operate on the default branch directly; worktree branches should merge back into the configured target branch.
- All worktree paths under `paths.runsDir/<task>/worktrees/<label>`.
- Persist every state change through StateStore; don't rely on git as source of truth.
- Cleanup should be idempotent (worktree may already be removed externally).
