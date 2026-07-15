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

### Scheduled tasks

Schedules run inside the Kanade server and are portable across macOS, Linux, and Windows. They always create a fresh task from a saved workflow. The fixed prompt is passed to the workflow as `args.prompt`.

```bash
kanade schedule add daily-review \
  --workflow repo-review \
  --prompt "Review open work and produce a concise report" \
  --cron "0 9 * * 1-5" \
  --timezone Asia/Shanghai \
  --cwd /path/to/repo \
  --thinking-level high \
  --skill /path/to/custom-skill

kanade schedule ls
kanade schedule show daily-review
kanade schedule runs daily-review
kanade schedule run daily-review
kanade schedule pause daily-review
kanade schedule resume daily-review
kanade schedule rm daily-review
```

The default overlap policy is `skip`. Missed runs older than one minute are also skipped by default instead of being backfilled. Use `--overlap allow` or `--misfire run_once` when creating a schedule to opt into different behavior.

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

POST   /schedules              Create schedule
POST   /schedules/:id/run      Run schedule immediately
PATCH  /schedules/:id          Update/pause/resume schedule
DELETE /schedules/:id          Delete schedule

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
GET  /schedules                List schedules
GET  /schedules/:id            Schedule details
GET  /schedules/:id/runs       Schedule dispatch history
```

Create schedule request:

```json
{
  "name": "daily-review",
  "cron": "0 9 * * 1-5",
  "timezone": "Asia/Shanghai",
  "task": {
    "source": "saved",
    "workflow_name": "repo-review",
    "args": { "prompt": "Review open work" },
    "options": {
      "cwd": "C:\\src\\project",
      "pi": {
        "thinking_level": "high",
        "skill_paths": ["C:\\pi-skills\\review"]
      }
    }
  }
}
```

## Compact monitoring examples

For coding agents, prefer compact output so task monitoring does not flood context:

```bash
kanade ls --status running
kanade show <task-id> | sed -n '1,140p'
curl -s http://127.0.0.1:7777/tasks/<task-id> | jq '{id:.task.id,status:.task.status,error:.task.error}'
```
