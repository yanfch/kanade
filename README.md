# kanade（奏）

> Multi-agent workflow runtime. LLM writes scripts, you save the good ones.

JavaScript scripts orchestrating multiple AI agents. Three sources (saved / inline / generated), one runtime, iterative refinement.

## Quick start

```bash
npm install
npm run dev           # Server on http://127.0.0.1:7777
npm test              # 294 tests
npm run eval          # Eval framework (mock mode)
```

## API

```
POST /tasks                    Create task (inline/saved/generated)
POST /tasks/:id/iterate        Iterate with new instructions (reuse worktree)
POST /tasks/:id/rerun          Rerun with journal cache
POST /tasks/:id/merge          Merge worktree branch
POST /tasks/:id/abort          Abort
POST /tasks/:id/respond        Respond to human request
GET  /tasks                    List tasks
GET  /tasks/:id                Task details + iteration chain
GET  /tasks/:id/snapshot       Real-time progress
GET  /tasks/:id/journal        Agent call journal
GET  /tasks/:id/artifacts      Debug artifacts
GET  /tasks/:id/sessions       Subagent sessions (if persisted)
GET  /events                   SSE stream
GET  /health                   Health check
```

## Iterative workflow

```bash
# Round 1
POST /tasks { source: "saved", workflow: "refactor" }

# Round 2: not satisfied, iterate
POST /tasks/T-0001/iterate { instructions: "add retry logic" }

# Round 3: still not done
POST /tasks/T-0002/iterate { instructions: "add unit tests" }

# Happy? Merge
POST /tasks/T-0003/merge
```

Each iteration injects `previousResult` + `reuseBranch` into args. Full chain tracked in `task_iterations` table.

## Stack

- Node.js 22 + TypeScript 5 (ESM, no build step)
- Hono · better-sqlite3 · acorn (JS sandbox)
- pi SDK — direct import, no spawn
- OpenTelemetry (spans + logs, OTLP ready)
- Biome · Vitest · Husky · GitHub Actions CI

## Configuration

```yaml
# ~/.kanade/config.yml
models:
  mode: inherit-pi    # "pi" is accepted as a shorthand alias
  agentDir: null
  authPath: null
  modelsPath: null
  inheritPiSettings: true

defaults:
  authorModel: gpt-5.4
  agentModel: gpt-5.3-codex-spark
  tokenBudget: 2000000
  concurrency: 16
  maxConcurrentTasks: 0        # 0 = unlimited

isolation:
  defaultMode: worktree
  defaultBaseBranch: develop
  prepareCommands:
    - "npm install"
    - "npm run lint -- --no-fix"

debug:
  dumpArtifacts: false
  persistSubagents: false

cleanup:
  enabled: true
  schedule: "0 * * * *"
  journalRetentionDays: 30

announcers: []                 # Event notifications (http_post, macos_notification, tts_local)
```

## Run command note

Use `--prepare-command` on `kanade run` to pass task-level worktree preparation commands (repeatable), which are sent to `/tasks` as `options.prepare_commands`.
In the live acceptance script, `--prepare` still means local pre-check commands (harness-only).

## Tests

```bash
npm test                        # All 294 tests
npx vitest run test/e2e-mock/   # E2E (40 tests)
npx vitest run eval/scorer*     # Eval scorer (17 tests)
npm run eval                    # Run eval suite (mock)
npx tsx eval/run.ts             # Run eval suite (real LLM, ~$0.30)
```

## License

MIT (TBD)
