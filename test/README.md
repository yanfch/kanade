# Tests

## Structure

```
test/
├── e2e-mock/          # Mock E2E tests (real runtime, mocked LLM)
│   ├── mock-session.ts
│   └── e2e.test.ts
└── README.md          # This file

src/
├── config/            # Config loading tests
├── journal/           # Journal cache tests
├── human/             # HumanGate tests
├── roles/             # Role loading tests
├── isolation/         # IsolationManager tests (real git operations)
├── server/            # TaskManager + HTTP route tests
├── workflow-engine/   # Runtime + WorkflowAgent tests
└── tracing/           # Tracing infrastructure tests
```

## Test Layers

### Layer 1: Unit Tests (in `src/`)

Individual module tests with minimal dependencies.

| Module | File | Tests | Covers |
|--------|------|-------|--------|
| config | `config.test.ts` | 2 | YAML loading, defaults, merge |
| journal | `journal.test.ts` | 9 | hashCall stability, read/write, cache hit, human responses |
| human | `human-gate.test.ts` | 5 | immediate resolve, poll, abort, invalid calls |
| roles | `roles.test.ts` | 7 | role loading, schema, default-model |
| tracing | `tracing.test.ts` | 7 | FileSpanExporter, FileLogExporter, Logger, setup |

### Layer 2: Integration Tests (in `src/`)

Cross-module tests using real implementations.

| Module | File | Tests | Covers |
|--------|------|-------|--------|
| workflow-engine | `runtime.test.ts` | 13 | Script parsing, request_human, caching, agent params |
| workflow-engine | `workflow-agent.test.ts` | 12 | Session creation, role filtering, schema override, journal, isolation |
| workflow-store | `workflow-store.test.ts` | 15 | CRUD, name validation, meta parsing |
| server | `app.test.ts` | 37 | All REST endpoints (happy + error paths) |
| server | `task-manager.test.ts` | 39 | Task lifecycle, abort, failure, events, metadata, list |
| isolation | `isolation-manager.test.ts` | 19 | Worktree CRUD, merge, reject, cleanup, finalize |

### Layer 3: Mock E2E Tests (in `test/e2e-mock/`)

Full execution chain with mocked LLM. Only `createAgentSession` is mocked — everything above (TaskManager → runWorkflow → WorkflowAgent) runs real code.

```
Coverage path:
  script text
    → parseWorkflowScript (AST parsing, meta validation)
    → vm.Script.runInContext (sandbox execution)
    → agent() / parallel() / pipeline() / phase() / request_human()
    → WorkflowAgent.run()
      → role loading (if role specified)
      → tool filtering
      → journal cache lookup
      → isolation prepare (if worktree)
      → createSession ← MOCKED
      → session.prompt ← MOCKED
      → structured_output tool ← MOCKED
      → result parsing
      → journal write
      → session.dispose
    → result returned
```

#### E2E Test Cases

| ID | Category | Test | What it validates |
|----|----------|------|-------------------|
| E1 | Single agent | structured output | Schema validation, result type, session created |
| E1 | Single agent | text return | No schema → returns assistant text |
| E1 | Single agent | instructions | Prompt includes instructions from caller |
| E2 | Parallel | 2 agents | Concurrent execution, both results returned |
| E2 | Parallel | validation | Non-function array throws |
| E3 | Pipeline | items through stages | Each item processed, correct count |
| E4 | Human | pause + resume | createRequest called, wait resolved, task completes |
| E5 | Failure | agent error | Returns null, workflow continues |
| E5 | Failure | script throw | Task fails with error message |
| E6 | Cache | journal reuse | Second run uses cached result, no new LLM call |
| E7 | Phases | tracking | Phases array populated correctly |
| E8 | Edge | no agents | Completes with 0 agent calls |
| E8 | Edge | args passing | Script receives args from create() |
| E8 | Edge | log() | Logs array contains messages |
| E8 | Edge | concurrency | Limiter constrains concurrent calls |

## Mock Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Real code (not mocked)                                      │
│                                                             │
│  TaskManager                                                │
│    → runWorkflow                                            │
│      → parseWorkflowScript                                  │
│      → vm.Script.runInContext                               │
│      → agent() / parallel() / pipeline()                    │
│      → WorkflowAgent                                        │
│        → loadRole()                                         │
│        → filterToolsByWhitelist()                           │
│        → hashCall() → journal.lookup()                      │
│        → buildSubagentPrompt()                              │
│        → createStructuredOutputTool()                       │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│ Mocked layer                                                │
│                                                             │
│  createAgentSession() → MockSession                         │
│    session.prompt()   → handler(text) → action              │
│    session.dispose()  → record disposed=true                │
│    session.abort()    → record aborted=true                 │
│                                                             │
│  MockAction types:                                          │
│    { type: "text", text: "..." }                            │
│    { type: "structured", value: { ... } }                   │
│    { type: "error", error: new Error("...") }               │
└─────────────────────────────────────────────────────────────┘
```

## Running Tests

```bash
# All tests
npm test

# Specific layer
npx vitest run src/journal/              # Unit tests
npx vitest run src/server/               # Integration tests
npx vitest run test/e2e-mock/            # E2E tests

# Single test
npx vitest run -t "journal cache"        # By name
npx vitest run src/isolation/isolation-manager.test.ts  # By file

# Watch mode
npx vitest watch
```

## Coverage Summary

```
Layer              Tests   Modules covered
──────────────────────────────────────────
Unit               30      config, journal, human, roles, tracing
Integration        135     runtime, workflow-agent, workflow-store,
                           app routes, task-manager, isolation-manager
Mock E2E           15      full execution chain
──────────────────────────────────────────
Total              180
```

### What's tested end-to-end (mock E2E)

- ✅ Script parsing → sandbox → result
- ✅ Agent call → session creation → prompt → result
- ✅ Structured output tool → schema validation
- ✅ Parallel concurrent execution
- ✅ Pipeline stage chaining
- ✅ request_human pause/resume
- ✅ Journal cache hit on rerun
- ✅ Agent failure isolation (null return)
- ✅ Script-level error propagation
- ✅ Phase tracking
- ✅ Args passing
- ✅ Log recording
- ✅ Concurrency limiter

### What's NOT tested (needs real LLM)

- ❌ Real LLM structured_output compliance
- ❌ Real tool execution (read, edit, bash)
- ❌ Role system prompt injection effectiveness
- ❌ Prompt quality → result quality
- ❌ Token budget enforcement
- ❌ Multi-turn agent sessions
- ❌ Worktree isolation with real file operations

## CI

GitHub Actions runs on push/PR to `main` and `develop`:

```yaml
jobs:
  check:
    - npm ci
    - biome lint
    - tsc --noEmit
    - vitest --run     # All 180 tests
```
