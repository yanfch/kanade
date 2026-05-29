# server

HTTP API + SSE event bus.

## What goes here

See `docs/02-orchestrator.md` §对外 API.

Files to add:

- `app.ts` — Hono app factory, mounts routes, wires middleware (W3C trace propagation, error handler, logging).
- `routes/tasks.ts` — `POST /tasks`, `GET /tasks`, `GET /tasks/:id`, `POST /tasks/:id/abort`, `POST /tasks/:id/respond`, `POST /tasks/:id/rerun`, `POST /tasks/:id/save`.
- `routes/events.ts` — SSE: `GET /tasks/:id/events`, `GET /events`. Subscribes to EventBus.
- `routes/workflows.ts` — `GET /workflows`, `GET /workflows/:name`, `PUT /workflows/:name`, `DELETE /workflows/:name` (read/write `paths.workflowsDir`).
- `routes/inbox.ts` — Wraps NeedsHuman queries: `GET /inbox`, used by panel/CLI.
- `event-bus.ts` — In-memory pub/sub (`EventEmitter` or simple typed bus). Events emitted by TaskManager + workflow runtime callbacks.
- `task-manager.ts` — Orchestrates task lifecycle: `create`, `run`, `abort`, `finalize`. Holds references to runtime/store/event bus/IsolationManager.
- `index.ts` — Re-exports + `startServer(config)` helper.

## Constraints

- Bind defaults to `127.0.0.1:7777`. No LAN exposure unless explicitly configured.
- All routes return JSON.
- SSE keepalive every 15s.
- `POST /tasks` accepts `source: "saved" | "inline" | "generated" | "auto"` (auto routes through workflow-author agent — see `docs/02-orchestrator.md` §Workflow Router).
