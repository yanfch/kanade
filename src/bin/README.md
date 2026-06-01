# CLI

Two entry points:

- `server.ts` — HTTP server (long-running)
- `kanade.ts` — Client CLI (talks to server via HTTP)

## Commands

```bash
# Server
kanade start --dir <path> --port <num>   # Start isolated instance
kanade health                             # Check server status

# Tasks
kanade ls [--status <state>] [--json]     # List tasks
kanade show <task-id> [--json]            # Task details + journal
kanade tail <task-id>                     # Follow SSE events
kanade run <name> [--args '{}'] [--follow]  # Run saved workflow
kanade iterate <id> --instructions '...'  # Iterate with new instructions
kanade save <task-id> --as <name>         # Save script as workflow

# Lifecycle
kanade abort <task-id>                    # Abort running task
kanade merge <task-id>                    # Merge worktree branch
kanade reject <task-id>                   # Reject, remove branch

# Workflows
kanade workflows [--json]                 # List saved workflows

# Human gate
kanade inbox [--json]                     # Pending requests
kanade respond <id> --request <req-id> --decision <approve|reject>
```

## Options

```
--url, -u <url>    Server URL (default: http://127.0.0.1:7777)
--json, -j         Output as JSON
--status, -s       Filter by status (ls)
--follow, -f       Follow events (run)
--instructions     Iterate instructions
```

## Isolation

Run multiple independent instances:

```bash
# Instance 1: default
kanade start --dir ~/.kanade --port 7777

# Instance 2: isolated task
kanade start --dir /tmp/kanade-task-a --port 7778

# Instance 3: another task
kanade start --dir /tmp/kanade-task-b --port 7779

# CLI targets specific instance
kanade --url http://127.0.0.1:7778 ls
kanade --url http://127.0.0.1:7779 run my-workflow
```

Each instance has its own database, worktrees, and config. No conflicts.

## Environment

```
KANADE_URL    Server URL (overridden by --url)
KANADE_DIR    Data directory (server only, default: ~/.kanade)
```

## Implementation

- `node:util.parseArgs` (built-in, no deps)
- All commands via HTTP, no direct DB access
- Human-readable output by default, `--json` for machine-readable
