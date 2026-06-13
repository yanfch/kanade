# Pi Kanade Cockpit Implementation Plan

This is the execution plan for `docs/pi-kanade-cockpit-design.md`.

## Target MVP

Build project-local Pi resources inside this repo that provide:

- one slash command: `/kanade`;
- a Pi overlay cockpit with task list + selected task detail;
- a compact Workflow Map tab;
- a compact Agent Session preview tab;
- safe task actions through panel dialogs;
- a Kanade skill that teaches Pi when/how to use Kanade tools.

## Project-local layout

Start with Pi's project-local auto-discovery layout so the extension and skill are usable immediately in this repository after project trust and `/reload`:

```text
.pi/
├── extensions/
│   └── kanade/
│       ├── index.ts        # extension entrypoint
│       ├── client.ts       # Kanade HTTP/SSE client (split out after MVP)
│       ├── types.ts        # API + UI types (split out after MVP)
│       ├── tools.ts        # LLM tools (split out after MVP)
│       ├── commands.ts     # /kanade command (split out after MVP)
│       ├── status.ts       # footer/widget status updater (split out after MVP)
│       ├── panel.ts        # overlay cockpit root component (split out after MVP)
│       ├── graph.ts        # workflow map rendering/model (split out after MVP)
│       ├── agent-session.ts# Pi session replay/live summaries (split out after MVP)
│       └── actions.ts      # respond/iterate/merge/reject/abort flows (split out after MVP)
└── skills/
    └── kanade/
        └── SKILL.md
```

For the first slice, a single-file `.pi/extensions/kanade/index.ts` is acceptable. Split it once the panel grows.

The extension is usable via project auto-discovery:

```bash
pi
# trust project if prompted
# then run /reload if files changed
# then run /kanade
```

It can also be tested explicitly:

```bash
pi -e ./.pi/extensions/kanade/index.ts
```

Later, if we want distribution outside this repo, package the same resources as a `pi-kanade/` Pi package.

## Phase 1 — Extension skeleton

1. Allow `.pi/extensions/**` and `.pi/skills/**` in `.gitignore`, while keeping private `.pi` settings/sessions ignored.
2. Create `.pi/extensions/kanade/index.ts`.
3. Create `.pi/skills/kanade/SKILL.md`.
4. Register `/kanade` only.
5. Add a small Kanade client:
   - base URL from `KANADE_URL`, default `http://127.0.0.1:7777`;
   - `health()`;
   - `listTasks()`;
   - `getTask(id)`;
   - `getInbox()`;
   - `getSnapshot(id)`;
   - `getWorktrees(id)`;
   - `listSessions(id)`;
   - `getSession(id, label)`;
   - task actions: `respond`, `iterate`, `merge`, `reject`, `abort`.
6. Add footer status on `session_start`, refreshed periodically while Pi is open.

Acceptance:

- `/kanade` opens an overlay.
- Footer shows connected/offline and task counts.
- No other slash commands are registered.

## Phase 2 — Cockpit panel MVP

Panel content:

- header with connection + counts;
- task list sorted by attention priority;
- detail pane with tabs:
  - `Map`
  - `Agent`
  - `Events`
  - `Worktree`
  - `Usage`
  - `Result`
- footer key hints.

Keyboard:

- `↑/↓`: select task/node/item;
- `tab`: switch tab;
- `enter`: action menu or detail drill-down;
- `r`: refresh;
- `esc`: close/back.

Acceptance:

- Running, needs-human, failed, and finished tasks render clearly.
- Failed/aborted tasks with preserved worktrees recommend inspect/iterate/keep, not cleanup.
- Panel is useful in narrow and wide terminals.

## Phase 3 — Safe task actions

Implement action menu based on task state.

### Running

- follow/view events;
- view snapshot;
- abort with confirmation.

### Needs human

- respond;
- inspect;
- iterate;
- abort with confirmation.

### Finished

- inspect;
- merge with strict confirmation;
- iterate;
- reject cleanup.

### Failed/aborted

- inspect preserved worktree;
- view failed node/agent history;
- iterate/continue;
- reject cleanup with strict confirmation;
- keep.

Acceptance:

- `merge`, `reject`, and `abort` always ask for confirmation.
- `respond` supports option selection and custom editor response.
- `iterate` opens an editor for instructions.

## Phase 4 — Agent session preview

First implementation can use existing Kanade endpoints:

```http
GET /tasks/:id/sessions
GET /tasks/:id/sessions/:label
```

Render compact Pi session timeline:

- user prompt;
- assistant thinking/text summary;
- tool calls;
- tool results;
- structured output;
- usage summaries.

Preferred local replay:

- if Kanade exposes an absolute session path, use Pi `SessionManager.open(sessionFile)`;
- otherwise consume API `entries`;
- fallback to direct JSONL parsing only when needed.

Acceptance:

- Agent tab shows subagent labels and a compact timeline.
- Current/last tool activity is summarized in the Map node when possible.

## Phase 5 — Workflow Map MVP

Initial map can use current snapshot and events:

- phases;
- agents;
- current phase;
- task status;
- human requests;
- failed/error state.

Render as vertical timeline first.

Then extend Kanade runtime with graph events:

```text
workflow.graph_initialized
workflow.graph_node_planned
workflow.graph_node_started
workflow.graph_node_completed
workflow.graph_node_failed
workflow.graph_edge_created
workflow.graph_cursor_moved
```

Semantic helpers should emit authoritative runtime graph nodes/edges:

- `analyze`
- `implement`
- `reviewChange`
- `continueImplementation`
- `testChange`
- `request_human`

Important graph details:

- review/test result outcome;
- issues/warnings summary;
- decision edge label/reason, e.g. `needs_fix`;
- loop count/attempts;
- linked agent label/session file;
- linked worktree/commit when available.

Acceptance:

- User can see where the workflow is now.
- Review/test feedback causing a loop is visible directly on node/edge.
- Failed node is highlighted with recovery actions.

## Phase 6 — Live agent session events

Add Kanade support for Pi subagent session live events.

Inside `WorkflowAgent`, subscribe to the Pi session:

```ts
session.subscribe((event) => {
  // emit compact workflow.agent_session_event through Kanade EventBus
});
```

SSE event should be compact by default:

- task id;
- node id if known;
- label;
- session file;
- event kind;
- tool name/call id;
- short summary;
- timestamp.

Do not stream huge read/bash output through SSE. Load full content on demand from session file/API.

Acceptance:

- Agent Live view updates while the agent runs.
- Map node shows current tool activity.
- If SSE disconnects, panel falls back to polling session entries.

## Phase 7 — Kanade skill

Create `pi-kanade/skills/kanade/SKILL.md`.

Skill rules:

- Use Kanade for multi-agent/background workflow tasks.
- Create generated tasks through `kanade_create_task`.
- Monitor with task/snapshot/graph/session tools.
- If `needs_human`, ask the user; do not decide silently.
- Do not merge from `finished` alone.
- For failed/aborted preserved worktrees, prefer inspect/iterate/keep.
- Use panel/confirmations for dangerous actions.

Acceptance:

- Pi can discover `/skill:kanade`.
- Model has clear guidance for safe Kanade usage.

## Kanade server changes likely needed

1. Add absolute subagent session path to session endpoints:

```json
{
  "label": "Implement_agent_1",
  "file": "...jsonl",
  "path": "/Users/.../.kanade/runs/T-0048/debug/subagents/...jsonl",
  "entries": []
}
```

2. Add workflow graph data to snapshot or a new endpoint:

```http
GET /tasks/:id/graph
```

3. Emit graph events from semantic helpers.

4. Emit compact subagent Pi session events from `session.subscribe()`.

## Test strategy

### Kanade repo tests

- API tests for session path exposure.
- Runtime tests for graph events emitted by semantic helpers.
- Snapshot/graph builder tests.
- E2E mock tests for graph endpoint and subagent session listing.

### Pi package tests/manual checks

Because Pi extensions are UI-heavy, start with:

- typecheck for extension files;
- unit tests for client/graph/session summarizers if practical;
- manual `pi -e ./pi-kanade/extensions/kanade/index.ts` smoke.

Manual smoke checklist:

1. Start Kanade server.
2. Open Pi with extension.
3. Run `/kanade`.
4. Verify task list.
5. Select running task.
6. View Map.
7. View Agent preview.
8. Respond to a human request.
9. Try merge/reject/abort confirmation flow.

## First coding slice

Start with Phase 1 + minimal Phase 2:

- package skeleton;
- client;
- `/kanade` overlay;
- footer status;
- task list;
- simple detail overview;
- no workflow graph events yet.

Then iterate into Agent preview and Workflow Map.
