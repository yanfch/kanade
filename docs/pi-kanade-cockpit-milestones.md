# Pi Kanade Cockpit Milestones

This is the practical development sequence for the Pi Kanade Cockpit.

Design references:

- `docs/pi-kanade-cockpit-design.md`
- `docs/pi-kanade-cockpit-ui-spec.md`
- `docs/pi-kanade-cockpit-theme.md`
- `docs/pi-kanade-cockpit-animations.md`
- `docs/pi-kanade-cockpit-implementation-plan.md`

## Current decision summary

- Build project-local Pi resources first:
  - `.pi/extensions/kanade/index.ts`
  - `.pi/skills/kanade/SKILL.md`
- Only one slash command: `/kanade`.
- Use overlay cockpit as the primary human UI.
- Keep footer status small.
- Use Pi theme tokens, not hardcoded colors.
- Do not require a custom Pi theme initially.
- No emoji by default.
- Running animation uses braille dots:

```ts
const KANADE_SPINNER = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
const KANADE_SPINNER_INTERVAL_MS = 200;
```

- Visual target: quiet cockpit baseline, not high-saturation dashboard.

## Milestone 0 — Docs and local resource scaffold

Status: mostly done.

Deliverables:

- `.gitignore` allows committed project-local Pi resources:
  - `.pi/extensions/**`
  - `.pi/skills/**`
  - `.pi/themes/**` optional
- design docs exist;
- local Kanade skill exists;
- minimal extension entrypoint exists or is ready to be replaced by structured implementation.

Acceptance:

- `git status` shows intended docs and `.pi` resources only.
- Pi can discover the project-local skill/extension after trust and `/reload`.

## Milestone 1 — Minimal working `/kanade` overlay

Status: implemented in `.pi/extensions/kanade/index.ts`; pending real Pi visual smoke.

Goal: see a useful cockpit, even before graph/live features are real.

Deliverables:

- Kanade client:
  - `health`
  - `listTasks`
  - `getInbox`
- footer status:
  - connected/offline;
  - running/waiting/failed counts;
- `/kanade` overlay:
  - header;
  - task list with attention sort;
  - selected task overview;
  - quiet cockpit styling;
  - no emoji;
  - braille spinner for running state;
- basic keyboard:
  - up/down;
  - tab;
  - refresh;
  - escape close.

Acceptance:

- `pi` + `/kanade` opens the cockpit.
- Works against local Kanade server at `KANADE_URL` or `http://127.0.0.1:7777`.
- Offline state is readable.
- Running/needs_human/failed/finished tasks are distinguishable.
- No dangerous actions yet.

Validation:

- extension typecheck or direct `pi -e` smoke;
- manual visual check in Ghostty dark theme;
- render helpers tested if already split out.

## Milestone 2 — Safe actions and dialogs

Status: initial implementation exists in the cockpit action menu; pending real Pi smoke and task-level manual validation.

Goal: the cockpit becomes operational.

Deliverables:

- contextual action menu;
- human response flow:
  - option selection;
  - custom editor response;
- iterate flow with editor;
- confirmations:
  - abort;
  - merge;
  - reject cleanup;
- failed recovery view:
  - inspect recommendation;
  - iterate/keep/reject cleanup actions.

Acceptance:

- `merge`, `reject cleanup`, and `abort` always require confirmation.
- Cancelled confirmation does not call Kanade API.
- Failed/aborted preserved worktrees recommend recovery, not deletion.
- `needs_human` can be resolved from the cockpit.

Validation:

- mock client unit tests for action flows;
- manual local task with `needs_human`;
- manual failed task recovery view.

## Milestone 3 — Agent session preview

Status: initial latest-session compact preview exists; richer selection/expansion is still pending.

Goal: see what Kanade agents did without leaving Pi.

Deliverables:

- fetch subagent session list:
  - `GET /tasks/:id/sessions`
  - `GET /tasks/:id/sessions/:label`
- compact agent timeline:
  - `[think]`
  - `[text]`
  - `[read]`
  - `[edit]`
  - `[bash]`
  - `[find]`
  - `[out]`
  - `[err]`
- active agent summary in Map/Overview.

Acceptance:

- Agent tab lists subagents for a task.
- Selecting an agent shows a quiet activity stream.
- Long outputs are summarized/truncated.
- No emoji by default.

Validation:

- unit tests for `summarizeAgentSession(entries)`;
- render snapshot for Agent tab;
- manual check using existing T-0038/T-0039 subagent sessions if available.

## Milestone 4 — Workflow Map from current snapshot/events

Status: initial implementation exists. `WorkflowSnapshot` now includes a lightweight `graph`, and `GET /tasks/:id/graph` exposes it.

Goal: show workflow progress even before full graph events exist.

Deliverables:

- use current task snapshot:
  - phases;
  - current phase;
  - agents;
  - running/done/error counts;
- render vertical Workflow Runtime map placeholder/sequence;
- highlight human and failure states;
- show review/failed summary when available from result/session.

Acceptance:

- Running task shows where execution roughly is.
- Failed task highlights stopped point or failure summary.
- Needs-human task highlights human node.

Validation:

- graph model/render unit tests;
- manual task run.

## Milestone 5 — Kanade runtime graph events

Status: partially started. SnapshotBuilder now derives graph nodes/edges from existing `workflow.phase`, `workflow.agent_started`, `workflow.agent_completed`, `task.needs_human`, `task.human_resolved`, `task.failed`, and `task.aborted` events. Dedicated semantic runtime graph events are still pending.

Goal: make the map authoritative and dynamic.

Kanade server/runtime deliverables:

- graph model in snapshot or `GET /tasks/:id/graph`;
- EventBus events:
  - `workflow.graph_initialized`
  - `workflow.graph_node_planned`
  - `workflow.graph_node_started`
  - `workflow.graph_node_completed`
  - `workflow.graph_node_failed`
  - `workflow.graph_edge_created`
  - `workflow.graph_cursor_moved`
- semantic helpers emit nodes/edges:
  - `analyze`
  - `implement`
  - `reviewChange`
  - `continueImplementation`
  - `testChange`
  - `request_human`
- review/test outcome summaries and edge reasons.

Cockpit deliverables:

- render real runtime graph;
- show `needs_fix` as warning, not task failure;
- show loop/back edge reason;
- node detail expansion.

Acceptance:

- User can see why execution looped back after review/test.
- Current node and active agent are obvious.
- Failed node is distinct from review feedback.

Validation:

- Kanade runtime tests for graph events;
- graph builder tests;
- e2e mock workflow with review -> continue -> review loop.

## Milestone 6 — Live agent session events

Goal: Agent Live updates as the subagent runs.

Kanade deliverables:

- subscribe to Pi subagent session events inside `WorkflowAgent`;
- emit compact `workflow.agent_session_event` through task SSE;
- include:
  - task id;
  - node id if known;
  - agent label;
  - session file;
  - event kind;
  - tool name/call id;
  - short summary;
  - timestamp.

Cockpit deliverables:

- attach to task SSE while overlay is open;
- update active node live summary;
- update Agent Live stream;
- fallback to polling session entries if SSE disconnects.

Acceptance:

- During a running task, user sees current tool activity in near real time.
- Large tool outputs are not streamed through SSE by default.
- SSE disconnect does not break the panel.

Validation:

- Kanade SSE tests for compact events;
- manual live run.

## Milestone 7 — Polish and optional native Pi integration

Deliverables:

- branch graph layout for wide terminals;
- help overlay;
- filter/search tasks;
- per-agent usage once Kanade exposes it;
- optional `Open in Pi` native session switch later;
- light theme polish if needed.

Acceptance:

- Cockpit remains quiet and readable.
- Advanced features do not clutter MVP flow.

## First development slice

Milestone 1 is now implemented enough for smoke testing.

Recommended order:

1. Split current single-file extension into testable modules only if needed; otherwise keep single-file for first smoke.
2. Make `/kanade` overlay render the quiet baseline.
3. Add braille spinner and footer status.
4. Verify manually in Pi/Ghostty.
5. Then add safe actions.

Do not start graph runtime changes until the basic cockpit is usable.
