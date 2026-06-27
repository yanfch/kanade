# CLI and HTTP API

Kanade is CLI-first. The CLI talks to the local HTTP server and is the recommended portable interface for humans and coding agents.

## CLI

### Server

```bash
kanade start --dir ~/.kanade --port 7777 --daemon
kanade health
```

Use `--url` or `KANADE_URL` to target another server:

```bash
kanade start --dir /tmp/kanade-dev --port 7778 --daemon
kanade --url http://127.0.0.1:7778 ls
```

### Tasks

```bash
kanade ls [--status running|finished|failed|needs_human] [--json]
kanade show <task-id> [--json]
kanade tail <task-id>
kanade run <workflow-name> [--args '{}'] [--follow]
kanade run --prompt '...' [--workflow-size small|medium|large] [--follow]
kanade iterate <task-id> --instructions '...'
kanade rerun <task-id> [--follow]
```

### Human gates

```bash
kanade inbox [--json]
kanade respond <task-id> --request <request-id> --decision approve
```

Read the request before responding. Do not approve or reject silently.

### Lifecycle

```bash
kanade merge <task-id>
kanade reject <task-id>
kanade abort <task-id>
kanade reconcile <task-id> [--merge-commit <sha>]
```

`merge`, `reject`, and `abort` are destructive or high-impact actions. Require explicit user confirmation in automation.

### Workflows

```bash
kanade workflows [--json]
kanade save <task-id> --as <workflow-name> [--force]
```

## HTTP API

```text
POST /tasks                    Create task (inline/saved/generated)
POST /tasks/:id/iterate        Iterate with new instructions
POST /tasks/:id/rerun          Rerun with journal cache
POST /tasks/:id/merge          Merge worktree branch
POST /tasks/:id/reconcile      Mark manually merged work as merged
POST /tasks/:id/abort          Abort running task
POST /tasks/:id/respond        Respond to human request
POST /tasks/:id/save           Save generated/inline script as workflow

GET  /tasks                    List tasks
GET  /tasks/:id                Task details + usage + iteration chain
GET  /tasks/:id/review         Merge-readiness review
GET  /tasks/:id/snapshot       Runtime progress snapshot
GET  /tasks/:id/events         Task event stream replay
GET  /tasks/:id/journal        Agent/human journal
GET  /tasks/:id/artifacts      Debug artifacts
GET  /tasks/:id/sessions       Persisted subagent sessions
GET  /inbox                    Pending human requests
GET  /events                   Global SSE stream
GET  /health                   Health check
```

## Compact monitoring examples

For coding agents, prefer compact output so task monitoring does not flood context:

```bash
kanade ls --status running
kanade show <task-id> | sed -n '1,140p'
curl -s http://127.0.0.1:7777/tasks/<task-id> | jq '{id:.task.id,status:.task.status,error:.task.error}'
```
