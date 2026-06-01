# AGENT.md

> Guide for AI agents working on kanade.

## What is kanade

Multi-agent workflow runtime. JavaScript scripts orchestrate AI agents. Three sources: saved / inline / generated.

```
POST /tasks → script parsed → sandbox execution → agents run → result
POST /tasks/:id/iterate → reuse worktree + previous result + new instructions
```

## Architecture

```
src/
├── config/           Config loading (YAML)
├── store/            SQLite state (tasks, worktrees, iterations, phases)
├── workflow-engine/  Runtime + sandbox + agent factory
│   ├── runtime.ts         VM sandbox, parallel/pipeline/request_human
│   ├── workflow-agent.ts  Session creation, role, retry, persistence
│   └── snapshot-builder.ts
├── isolation/        Git worktree lifecycle
├── server/           HTTP API + TaskManager + announcer + cleanup
└── tracing/          OTel spans + logs

eval/                 Eval framework (scorer, reporter, runner)
test/e2e-mock/        E2E tests (mock LLM)
```

## Key files to read first

1. `src/workflow-engine/runtime.ts` — sandbox execution, parallel/pipeline
2. `src/workflow-engine/workflow-agent.ts` — agent session, retry, persistence
3. `src/server/task-manager.ts` — task lifecycle, iterate, rerun
4. `src/server/app.ts` — HTTP routes
5. `src/store/state-store.ts` — database schema

## Development

```bash
npm test              # 304 tests (unit + integration + E2E + CLI)
npm run lint          # Biome check
npm run typecheck     # TypeScript check
npm run eval          # Eval framework (mock mode)
```

## Running multiple instances

Each instance uses a separate `KANADE_DIR` and port:

```bash
kanade start --dir ~/.kanade --port 7777          # default
kanade start --dir /tmp/kanade-dev --port 7778    # isolated
kanade --url http://127.0.0.1:7778 ls             # CLI targets specific instance
```

Always run `npm run lint && npm run typecheck && npm test` before committing.

## Testing patterns

- **Unit tests**: in `src/` next to source files (`.test.ts`)
- **E2E tests**: `test/e2e-mock/` — real TaskManager, mock LLM session
- **Eval tests**: `eval/scorer.test.ts` — scoring logic

Mock session factory: `test/e2e-mock/mock-session.ts`
E2E setup: `test/e2e-mock/setup.ts` — creates temp dir, injects mock session

## Config

```yaml
# ~/.kanade/config.yml
defaults:
  model: claude-sonnet-4
  maxConcurrentTasks: 0        # 0 = unlimited
isolation:
  defaultMode: worktree
debug:
  persistSubagents: false
  dumpArtifacts: false
cleanup:
  enabled: true
  schedule: "0 * * * *"
announcers: []                 # Event notifications
```

## Events

14 event types via EventBus:
- `task.created/running/finished/failed/aborted`
- `task.needs_human/human_resolved/merged/rejected`
- `workflow.phase/agent_started/agent_completed/log`
- `task.script_generated`

Listeners: AnnouncerRegistry, SnapshotBuilder, SSE streams.

## Iteration flow

```
POST /tasks → T-0001 (initial)
POST /tasks/T-0001/iterate { instructions: "..." } → T-0002
POST /tasks/T-0002/iterate { instructions: "..." } → T-0003
POST /tasks/T-0003/merge → merged to develop
```

Args injected: `previousResult`, `previousTaskId`, `instructions`, `reuseBranch`.

## CLI

```bash
kanade start --dir <path> --port <num>  # Start isolated server
kanade health                           # Check server
kanade ls [--status <s>] [--json]       # List tasks
kanade show <id> [--json]               # Task details
kanade run <workflow> [--args '{}']     # Run saved workflow
kanade iterate <id> --instructions '..' # Iterate on task
kanade workflows                        # List workflows
kanade merge <id>                       # Merge worktree
kanade reject <id>                     # Reject, cleanup
```

## Docs

- `docs/feature-gaps.md` — status and remaining tasks
- `docs/test-plan.md` — test coverage breakdown
- `src/bin/README.md` — CLI details
- Design docs: `../gui-tui/docs/` (outside repo)
