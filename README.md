# kanade（奏）

> Multi-agent workflow runtime. LLM writes scripts, you save the good ones.

A unified workflow engine that runs JavaScript scripts orchestrating multiple AI agents. Three script sources (saved / inline / generated), one runtime.

## Status

Private alpha. Skeleton only — implementation in progress.

## Stack

- Node.js 22 + TypeScript 5 (ESM-only, no build step in dev: `tsx`)
- Hono (HTTP server) · better-sqlite3 (state) · acorn (JS AST sandbox)
- pi SDK (`@earendil-works/pi-coding-agent`) — direct import, no spawn
- OpenTelemetry (FileSpanExporter for MVP)
- Biome (lint + format) · Vitest (test)

## Layout

```
src/
├── bin/              # CLI entry points (server, kanade client)
├── config/           # Path constants, config.yml loader  ✅ done
├── store/            # SQLite state store (5 tables)      ✅ done
├── workflow-engine/  # Sandboxed JS runtime (fork pi-dynamic-workflows)
├── roles/            # Role loader, prompt builder, tool whitelist
├── isolation/        # Worktree lifecycle (IsolationManager)
├── journal/          # Per-task agent-call result cache
├── human/            # NEEDS_HUMAN gate (request_human)
├── tracing/          # OTel + FileSpanExporter
└── server/           # Hono HTTP API + SSE + TaskManager
```

Each subdirectory has its own `README.md` describing what to implement and which design doc to follow.

## Getting started

```bash
npm install
npm run dev      # tsx watch src/bin/server.ts
npm run cli -- ls
npm test
npm run lint
```

## Implementation order

1. ✅ `config/` + `store/` — data layer
2. `workflow-engine/` — fork pi-dynamic-workflows + add role support
3. `roles/` — role loading, prompt builder
4. `isolation/` — worktree manager
5. `journal/` + `human/` — caching + NEEDS_HUMAN
6. `tracing/` — FileSpanExporter
7. `server/` — Hono routes + SSE + TaskManager
8. `bin/` — CLI commands

## Design docs

External (workspace-level): see the integrator's design notes for full context. Each subdirectory's `README.md` references the relevant design doc by relative path (`docs/02-orchestrator.md` etc., located outside this repo).

## License

MIT (TBD)
