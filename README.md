# kanade（奏）

> Multi-agent workflow runtime. LLM writes scripts, you save the good ones.

A unified workflow engine that runs JavaScript scripts orchestrating multiple AI agents. Three script sources (saved / inline / generated), one runtime.

## Status

Private alpha. Core runtime functional, real LLM integration pending.

**Working**: server, CLI, task lifecycle, worktree isolation, merge workflow, tracing, 180 tests.  
**Needs**: real LLM auth for generated mode, subagent session persistence, cleanup scheduler.

## Stack

- Node.js 22 + TypeScript 5 (ESM-only, no build step in dev: `tsx`)
- Hono (HTTP server) · better-sqlite3 (state) · acorn (JS AST sandbox)
- pi SDK (`@earendil-works/pi-coding-agent`) — direct import, no spawn
- OpenTelemetry (spans + logs via FileExporter, OTLP ready)
- Biome (lint + format) · Vitest (test) · Husky (pre-commit hooks)
- GitHub Actions CI (lint + typecheck + test)

## Quick start

```bash
npm install
npm run dev           # Start server on http://127.0.0.1:7777
npm run cli -- health # Check server status
npm test              # Run all 180 tests
npm run lint          # Biome check
npm run typecheck     # TypeScript check
```

## CLI

```bash
kanade health                              # Server status
kanade ls                                  # List tasks
kanade ls --status running                 # Filter by status
kanade show T-0001                         # Task details
kanade tail T-0001                         # Follow events (SSE)
kanade run feature-iteration --args '{}'   # Run a saved workflow
kanade run deep-research --follow          # Run and follow events
kanade inbox                               # Pending human requests
kanade respond T-0001 --request req-1 --decision approve
kanade abort T-0001                        # Abort running task
kanade merge T-0001                        # Merge branch into develop
kanade reject T-0001                       # Reject, remove branch
kanade workflows                           # List saved workflows
kanade save T-0001 --as my-workflow        # Save script as workflow
```

## API

```
POST /tasks                    Create task (source: inline/saved/generated)
GET  /tasks                    List tasks
GET  /tasks/:id                Task details
GET  /tasks/:id/journal        Agent call journal
GET  /tasks/:id/script         Workflow script
GET  /tasks/:id/artifacts      Debug artifacts
GET  /tasks/:id/sessions       Subagent session list
GET  /tasks/:id/sessions/:label  Read subagent session JSONL
POST /tasks/:id/abort          Abort
POST /tasks/:id/respond        Respond to human request
POST /tasks/:id/rerun          Rerun with journal cache
POST /tasks/:id/save           Save script as workflow
POST /tasks/:id/merge          Merge branch into develop
POST /tasks/:id/reject         Reject, remove branch
GET  /workflows                List saved workflows
GET  /workflows/:name          Get workflow
PUT  /workflows/:name          Create/update workflow
DELETE /workflows/:name        Delete workflow
GET  /events                   Global SSE stream
GET  /tasks/:id/events         Task SSE stream
GET  /inbox                    Pending human requests
GET  /health                   Health check
```

## Layout

```
src/
├── bin/              CLI entry points (server, kanade client)
├── config/           Path constants, config.yml loader
├── store/            SQLite state store (tasks, worktrees, agent_calls, needs_human, phases)
├── workflow-engine/  Sandboxed JS runtime (fork pi-dynamic-workflows)
│   ├── runtime.ts         Script parser + sandbox executor
│   ├── workflow-agent.ts  Per-call subagent factory (role, journal, isolation)
│   ├── structured-output.ts
│   ├── snapshot.ts
│   └── prompt-guidelines.ts
├── roles/            Role loader, prompt builder, tool whitelist
├── isolation/        Worktree lifecycle (IsolationManager)
│   └── isolation-manager.ts  create/reuse/cleanup/merge/reject
├── journal/          Per-task agent-call result cache (SQLite)
├── human/            NEEDS_HUMAN gate (request_human)
├── tracing/          OTel Logs + Spans + Logger
│   ├── setup.ts           setupTracing(config)
│   ├── file-span-exporter.ts
│   ├── file-log-exporter.ts
│   ├── logger.ts          Structured logger with traceId/spanId
│   └── attributes.ts      OTel GenAI + kanade attribute constants
└── server/           Hono HTTP API + SSE + TaskManager
    ├── app.ts             Routes + middleware
    ├── task-manager.ts    Task lifecycle orchestration
    ├── workflow-store.ts  Saved workflow CRUD
    ├── workflow-author.ts Stub + LLM workflow generator
    ├── event-bus.ts       In-memory pub/sub
    └── errors.ts          AppError with HTTP status

test/
└── e2e-mock/         Mock E2E tests (real runtime, mocked LLM)
```

## Configuration

```yaml
# ~/.kanade/config.yml
server:
  port: 7777
  bind: 127.0.0.1

defaults:
  model: claude-sonnet-4
  tokenBudget: 2000000
  concurrency: 16

isolation:
  defaultMode: worktree
  defaultBaseBranch: develop
  branchPrefix: kanade

merge:
  targetBranch: develop
  useNoFf: true
  requireCleanLint: true
  requireCleanTest: true
  deleteBranchAfterMerge: true

tracing:
  enabled: true
  serviceName: kanade
  exporters:
    - type: file
    - type: otlp_http           # Braintrust / self-hosted collector
      endpoint: ${OTEL_EXPORTER_OTLP_ENDPOINT}

debug:
  dumpArtifacts: false
  persistSubagents: false
  persistFilter:          # Optional: only persist specific labels
    labels: []

cleanup:
  journalRetentionDays: 30
  traceRetentionDays: 90
```

## Tests

180 tests across 3 layers:

| Layer | Tests | What |
|-------|-------|------|
| Unit | 50 | Config, journal, human gate, roles, tracing, session persistence, cleanup |
| Integration | 141 | Runtime, workflow-agent, app routes, task-manager, isolation |
| Mock E2E | 23 | Full execution chain (script → sandbox → agent → session, persistence, cleanup) |

```bash
npm test                        # All tests
npx vitest run test/e2e-mock/   # E2E only
npx vitest run src/server/      # Server tests only
```

See `test/README.md` for detailed coverage and mock architecture.

## Design docs

Located in `../gui-tui/docs/` (outside this repo):

- `02-orchestrator.md` — Core architecture, API, task lifecycle
- `06-workflow-engine.md` — Runtime internals, role system
- `10-isolation.md` — Worktree strategy, merge workflow, CLI commands

## License

MIT (TBD)
