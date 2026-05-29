# workflow-engine

Fork from [pi-dynamic-workflows](https://github.com/Michaelliv/pi-dynamic-workflows).

## What goes here

Core JavaScript workflow runtime (sandboxed). See `docs/06-workflow-engine.md`.

Files to add (porting from upstream + our changes):

- `runtime.ts` — `parseWorkflowScript` + `runWorkflow` (vm sandbox, agent/parallel/pipeline/phase primitives). Port from upstream `workflow.ts`.
- `workflow-agent.ts` — Per-call subagent factory using pi SDK. Add **role support** (load `~/.kanade/roles/<role>/`, filter tools by whitelist, inject role system prompt, default schema/model). Port from upstream `agent.ts`.
- `structured-output.ts` — Terminating `structured_output` tool. Copy verbatim from upstream.
- `snapshot.ts` — Execution state model (port from upstream `display.ts` data-model only, drop pi-tui rendering).
- `human.ts` — `request_human()` primitive: insert into `needs_human` table via StateStore, poll for resolution, support journal cache.
- `journal.ts` — Per-task SQLite journal (`runs/<task>/journal.db`) for `agent()` cache key → result lookup. Hash key includes prompt + role + schema + model.
- `prompt-guidelines.ts` — Promptbuilder for the workflow-author role (see `docs/02-orchestrator.md` Workflow Router section). Port the guidelines from upstream `workflow-tool.ts`.
- `index.ts` — Re-exports.

## Constraints

- Don't break sandbox (DETERMINISM_BLOCKLIST + AST whitelist for meta literal).
- Keep `vm.createContext` whitelist minimal — never expose `process`, `require`, `import`, fs, network APIs.
- All side effects (file write, SQLite, OTLP) go through injected services; runtime stays pure JS evaluator.
- Concurrency limiter default 16, configurable via `RunOptions.concurrency`.

## License header

Each file ported from upstream must keep:

```ts
// Portions of this file are derived from pi-dynamic-workflows
// (https://github.com/Michaelliv/pi-dynamic-workflows), MIT licensed.
```

Add `NOTICE.md` at repo root listing fork sources.
