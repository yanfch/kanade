# bin

CLI entrypoints. Two binaries:

- `server.ts` — `kanade serve` / `npm run dev`: starts HTTP server, holds long-running process.
- `kanade.ts` — `kanade <subcommand>`: client CLI that talks to the running server via HTTP.

## CLI subcommands (see docs/10-isolation.md §CLI 命令汇总)

- `kanade serve [--port N]` — start server
- `kanade ls [--status=<state>]` — list tasks
- `kanade show <task-id>` — task details (artifacts, agent_calls, worktrees, phases)
- `kanade tail <task-id>` — follow SSE event stream
- `kanade inbox` — pending NEEDS_HUMAN
- `kanade respond <task-id> --decision <approve|reject> [--note "..."]`
- `kanade abort <task-id>`
- `kanade merge <task-id>` — merge worktree branch to base
- `kanade reject <task-id> --reason "..."` — drop without merge
- `kanade worktrees` — list active worktrees
- `kanade worktree clean` — manual stale cleanup
- `kanade worktree path <task-id>` — print worktree dir (for `cd`)
- `kanade run <workflow-name> [--args '{...}']` — run a saved workflow
- `kanade save <task-id> --as <name>` — save generated workflow.js to library

## Implementation notes

- Use `node:util.parseArgs` (built-in). No commander/yargs.
- All commands hit local HTTP. No direct DB access from CLI process.
- Output: human-readable by default, `--json` flag for machine-readable.
