# Pi Kanade Cockpit Design

## Goal

Build a Pi extension + skill that makes Kanade usable directly inside Pi before a standalone UI exists.

The extension should feel like a **Kanade Cockpit inside Pi**:

- one command opens a rich task panel;
- users can inspect tasks, workflow execution, human gates, and agent sessions;
- LLMs can create/observe Kanade tasks through tools guided by a Kanade skill;
- dangerous actions require explicit user confirmation;
- failed/aborted worktrees are treated as recoverable state, not trash.

## Non-goals for the first version

- Do not build a standalone web UI.
- Do not add many slash commands.
- Do not deep-import Pi internal interactive renderers as a stable dependency.
- Do not switch into subagent Pi sessions by default. Native `Open in Pi` can be a later action.
- Do not rely only on a task being `finished`; merge remains an explicit reviewed decision.

## High-level shape

Use three UI layers:

1. **Footer status** — always-on, tiny, non-invasive.
2. **Overlay cockpit** — opened by `/kanade`, primary human operation surface.
3. **Modal dialogs** — focused confirmations and human responses.

This keeps Pi's main conversation clean while still providing fast access to Kanade state.

```text
Pi conversation
────────────────────────────────────────
Assistant/user messages stay normal.

[optional small widget only when urgent]

> editor
────────────────────────────────────────
footer: K: ● connected · ▶1 · ?1 · ✖1
```

When the user runs `/kanade`, show an overlay:

```text
╭─ Kanade Cockpit ─────────────────────────────────────────────────────╮
│ ● connected  http://127.0.0.1:7777     ▶ 1 running   ? 1 ask   ✖ 1 failed │
├───────────────────────────────┬──────────────────────────────────────┤
│ Tasks                         │ T-0048  ▶ running                    │
│                               │ Add Pi Kanade cockpit                │
│ > ? T-0049  Review decision   │                                      │
│   ▶ T-0048  Pi extension      │ [Map] Agent Events Worktree Usage    │
│   ✖ T-0039  Usage failed      │                                      │
│   ✓ T-0042  Usage accounting  │  ✓ 1 Analyze                         │
│                               │      plan ready · 3 findings         │
│                               │       │                              │
│                               │       ▼                              │
│                               │  ✓ 2 Implement                       │
│                               │      changed 4 files                 │
│                               │       │                              │
│                               │       ▼                              │
│                               │  ✖ 3 Review                          │
│                               │      needs_fix · 2 blocking issues   │
│                               │       │ needs_fix: missing author cost│
│                               │       ▼                              │
│                               │  ▶ 4 Continue Implementation          │
│                               │      live: ✏️ edit task-manager.ts    │
├───────────────────────────────┴──────────────────────────────────────┤
│ ↑↓ select · Enter actions/detail · Tab tab · r refresh · Esc close    │
╰──────────────────────────────────────────────────────────────────────╯
```

## Command philosophy

Only one slash command is required:

```text
/kanade
```

Optional later shortcut:

```text
ctrl+shift+k
```

Everything else is either:

- an action inside the panel; or
- an LLM tool call guided by the Kanade skill.

This avoids command sprawl. Humans operate through the cockpit. The LLM operates through hidden tools.

## Extension responsibilities

### User-facing UI

- `/kanade` opens the cockpit overlay.
- Footer status shows compact Kanade health and attention state.
- Optional urgent widget appears only for `needs_human` or failed preserved worktrees.
- Modal dialogs handle confirmations and human responses.

### LLM tools

Expose Kanade operations as tools for the model, not as slash commands:

- `kanade_health`
- `kanade_list_tasks`
- `kanade_create_task`
- `kanade_get_task`
- `kanade_get_snapshot`
- `kanade_get_workflow_graph`
- `kanade_get_agent_sessions`
- `kanade_get_agent_session`
- `kanade_get_inbox`
- `kanade_respond_human`
- `kanade_iterate_task`
- `kanade_merge_task`
- `kanade_reject_task`
- `kanade_abort_task`

Dangerous tools require UI confirmation:

- merge
- reject cleanup
- abort

If `ctx.hasUI` is false, dangerous actions should fail closed with a clear message.

## Skill responsibilities

The `kanade` skill should tell Pi when and how to use Kanade:

- Use Kanade for multi-agent workflow tasks, generated workflow tasks, long-running implementation/review/test loops, and tasks where user wants background execution.
- Create tasks with `kanade_create_task` instead of shelling out to the CLI.
- Monitor with `kanade_get_task`, `kanade_get_snapshot`, graph/session tools, and inbox tools.
- If `needs_human`, ask the user through cockpit/dialog instead of deciding silently.
- Do not merge based on `finished` alone. Inspect workflow, graph, review/test result, worktree diff, checks/evidence, and usage.
- For failed/aborted tasks with preserved worktrees, prefer inspect/iterate/keep over reject cleanup.

## UI placement decision

### Footer only

Pros:

- Always visible.
- Does not interrupt the current Pi conversation.

Cons:

- Too small for graph, agent timeline, human gate forms, or actions.

Use footer only for compact status:

```text
K: ● connected · ▶1 · ?1 · ✖1
K: ? T-0049 waiting for you
```

### Inline body widget

Pros:

- Can show persistent information above/below editor.
- Good for urgent state.

Cons:

- Can clutter the normal Pi conversation.
- Not enough room for a workflow graph.
- Persistent large widgets compete with the editor.

Use inline widget sparingly, only for urgent attention:

```text
Kanade needs input: T-0049 Review decision  [open /kanade]
```

### Overlay cockpit

Pros:

- Rich enough for a real cockpit.
- Does not permanently pollute the main conversation.
- Supports keyboard navigation, action menus, tabs, graph, and live agent view.

Cons:

- Not always visible.
- Needs one command/shortcut to open.

Decision: **Use overlay cockpit as the primary UI.**

## Cockpit layout

### Wide layout

Use split panes:

```text
Header
├── Task list pane
└── Task detail pane
    ├── tabs
    └── active tab content
Footer hints
```

### Narrow layout

Use stacked layout:

```text
Header
Task list
Task detail
Footer hints
```

### Header

Show connection and summary:

```text
● connected  http://127.0.0.1:7777     ▶ 1 running   ? 1 ask   ✖ 1 failed
```

Connection states:

- `● connected`
- `◌ reconnecting`
- `✖ offline`

### Task list

Show attention-first tasks:

1. `needs_human`
2. failed/aborted with preserved worktree
3. running
4. recent finished
5. older tasks if space allows

Card style:

```text
▸ ? T-0049  Review merge decision
    needs_human · reviewer · waiting for you

  ▶ T-0048  Add Pi extension panel
    running · implement · 8m · $0.18

  ✖ T-0039  Usage task failed
    failed · worktree preserved · timed out
```

Status icons:

```text
▶ running
? needs_human
✓ finished
✖ failed
⚑ aborted
○ pending/planned
↺ loop
```

## Detail tabs

The task detail pane has these tabs:

```text
Map | Agent | Events | Worktree | Usage | Result
```

Default tab by task state:

- `running`: Map
- `needs_human`: Map with human node highlighted
- `failed/aborted`: Map with failed node highlighted
- `finished`: Map

## Workflow Map

The Workflow Map is the key differentiator. It should answer:

- where is the workflow now?
- what has already completed?
- which agent is currently running?
- why did a review/test send execution backward?
- where is a human decision required?
- where did the task fail?

### Runtime-first graph

Kanade workflows are dynamic JavaScript. A generated workflow may be static-looking, but execution can branch or loop based on runtime results.

Therefore:

- static analysis may provide a dim **planned graph**;
- runtime events provide the authoritative **actual graph**.

### MVP graph form

Use a vertical execution timeline first because it is robust in terminals:

```text
✓ 1 Analyze
    plan complete · 3 findings
     │
     ▼
✓ 2 Implement
    changed 4 files · commit 9ac12ef
     │
     ▼
✖ 3 Review
    needs_fix · 2 blocking issues
     │ needs_fix: usage total misses author cost
     ▼
▶ 4 Continue Implementation
    Implement agent 2 · live: ✏️ edit task-manager.ts
     │
     └────────↺ returns to Review
○ 5 Review
○ 6 Test
```

Later, wide terminals can support a branch layout:

```text
Analyze → Implement → Review ─approved→ Test
                        │
                        └needs_fix→ Continue ─↺ Review
```

### Node types

```ts
type WorkflowGraphNodeKind =
  | "author"
  | "validation"
  | "phase"
  | "analyze"
  | "implement"
  | "reviewChange"
  | "continueImplementation"
  | "testChange"
  | "agent"
  | "human"
  | "decision";
```

### Node state

```ts
type WorkflowGraphNodeStatus =
  | "planned"
  | "queued"
  | "running"
  | "done"
  | "needs_human"
  | "failed"
  | "skipped";
```

### Edge types

```ts
type WorkflowGraphEdgeKind =
  | "sequence"
  | "input"
  | "decision"
  | "loop"
  | "parallel"
  | "join";
```

Edges must carry human-readable reason text when available:

```ts
interface WorkflowGraphEdge {
  id: string;
  from: string;
  to: string;
  kind: WorkflowGraphEdgeKind;
  label?: string;       // e.g. needs_fix, approved, failed, retry
  reason?: string;      // e.g. review.status === "needs_fix"
  summary?: string;     // short display text
}
```

### Review/test feedback display

Review and test nodes should surface structured outcomes:

```text
✖ 3 Review
    needs_fix · 2 blocking issues

Issues
1. usage.total only counts runtime usage
2. CLI still labels journal cache as Agent Calls

Edge
needs_fix → Continue Implementation
Reason: review.status === "needs_fix"
```

This makes the “why did it go back?” question obvious.

### Agent activity attached to nodes

Each running agent node should show one-line live activity:

```text
▶ 4 Continue Implementation
    agent: Implement agent 2
    live: 📖 read src/server/task-manager.ts
```

The full agent timeline lives in the Agent tab or a node detail view.

## Agent tab and node drill-down

When a graph node has an agent session, pressing Enter opens node actions:

```text
╭─ Continue Implementation ─────────────╮
│ > View agent live                      │
│   View agent history                   │
│   View result                          │
│   View worktree diff                   │
│   Copy session path                    │
│   Back                                 │
╰───────────────────────────────────────╯
```

### Agent live view

Panel-internal live view, not native Pi session switching:

```text
╭─ Agent Live: Implement agent 2 ─────────────────────────────╮
│ Task T-0048 · Node 4 Continue Implementation                │
│                                                            │
│ 🧠 thinking                                                 │
│   Need to patch usage aggregation...                        │
│                                                            │
│ 📖 read src/server/task-manager.ts                          │
│   ✓ 820 lines                                               │
│                                                            │
│ ✏️ edit src/server/task-manager.ts                          │
│   +26 -4                                                    │
│                                                            │
│ 🔧 bash npm run typecheck                                   │
│   running 18s...                                            │
│                                                            │
│ Esc back to map · e expand · f follow tail                  │
╰────────────────────────────────────────────────────────────╯
```

### Agent history view

For completed agents, render a compact Pi session timeline:

```text
Agent History: Review agent 1
────────────────────────────
09:31:02 user prompt
09:31:10 🧠 thinking
09:31:11 📖 read src/server/task-manager.ts
09:31:20 📖 read src/bin/kanade.ts
09:32:02 structured_output
         status: needs_fix
         issues: 2
```

### Data sources

Use a hybrid approach:

1. **Historical replay** from Pi session JSONL using Pi's own `SessionManager.open(sessionFile)` when possible.
2. **Live updates** from Kanade SSE events.
3. **Fallback** to polling/tailing session JSONL if SSE is unavailable.

Direct JSONL parsing is acceptable as a fallback, but preferred local replay should use Pi's native `SessionManager` API.

## Kanade runtime graph events

Existing events are too flat:

- `workflow.phase`
- `workflow.agent_started`
- `workflow.agent_completed`

Add graph-specific events:

```text
workflow.graph_initialized
workflow.graph_node_planned
workflow.graph_node_started
workflow.graph_node_completed
workflow.graph_node_failed
workflow.graph_edge_created
workflow.graph_cursor_moved
workflow.agent_session_started
workflow.agent_session_event
workflow.agent_session_finished
```

### Example graph node event

```json
{
  "type": "workflow.graph_node_completed",
  "taskId": "T-0048",
  "node": {
    "id": "step_3",
    "seq": 3,
    "kind": "reviewChange",
    "label": "Review",
    "status": "done",
    "outcome": "needs_fix",
    "summary": "2 blocking issues",
    "agentLabel": "Review agent 1",
    "resultPreview": "needs_fix: usage total misses author cost"
  }
}
```

### Example edge event

```json
{
  "type": "workflow.graph_edge_created",
  "taskId": "T-0048",
  "edge": {
    "id": "edge_step_3_step_4",
    "from": "step_3",
    "to": "step_4",
    "kind": "decision",
    "label": "needs_fix",
    "reason": "review.status === \"needs_fix\"",
    "summary": "Review found 2 blocking issues"
  }
}
```

### Example agent session event

Keep SSE payloads compact. Do not stream huge read outputs through task events by default.

```json
{
  "type": "workflow.agent_session_event",
  "taskId": "T-0048",
  "label": "Implement agent 2",
  "nodeId": "step_4",
  "sessionFile": "/Users/.../debug/subagents/Implement_agent_2/....jsonl",
  "eventKind": "tool_execution_start",
  "toolName": "edit",
  "toolCallId": "call_xxx",
  "summary": "edit src/server/task-manager.ts",
  "timestamp": 1781256145776
}
```

Full content can be loaded from the session file/API on demand.

## Static workflow preview

When `workflow.js` is generated or loaded, Kanade can parse it for a best-effort planned graph.

Rules:

- Semantic helper calls become planned nodes.
- Data dependencies become planned edges where obvious.
- `if (review.status === "needs_fix")` style checks create decision/loop ghost edges when recognized.
- Unknown dynamic logic is allowed; show:

```text
Runtime graph will appear as the workflow executes.
```

Planned nodes should render dim until runtime confirms them.

## Actions by task state

### Running

- Follow graph live
- View active agent
- View events
- Abort, with confirmation

### Needs human

- Respond
- Inspect node/graph
- Iterate
- Abort, with confirmation

Human node should be highlighted:

```text
? 5 Human Approval
    waiting for user
```

### Finished

- Inspect graph
- Inspect worktree
- Merge, with strict confirmation
- Iterate
- Reject cleanup

Merge confirmation:

```text
Merge T-0048 into main?

Only merge after inspecting workflow, graph, diff, checks, evidence, and usage.

[Cancel] [Merge]
```

### Failed/aborted

- View failed node
- View agent history
- Inspect preserved worktree
- Iterate / continue
- Reject cleanup, with strict confirmation
- Keep

Failed task view should recommend inspect/iterate/keep, not cleanup.

## Safety principles

- Dangerous actions require explicit confirmation.
- Failed/aborted preserved worktrees are valuable recovery state.
- Merge cannot be inferred from `finished`.
- LLM tools should not silently merge/reject/abort without UI confirmation.
- Full agent output can be large; compact previews should be used by default.

## Implementation phases

### Phase 1 — Cockpit skeleton

- Package structure for Pi extension + skill.
- One `/kanade` command.
- Footer status.
- Overlay with task list and basic details.
- Basic actions: respond, abort, iterate, merge, reject cleanup.

### Phase 2 — Agent session preview

- Fetch/list Kanade subagent sessions.
- Use Pi `SessionManager.open()` for local session replay when path is available.
- Render compact agent timeline.
- Poll/tail session files as fallback.

### Phase 3 — Runtime workflow graph

- Add graph model to Kanade snapshot.
- Emit graph node/edge events from semantic helpers.
- Render vertical workflow map.
- Highlight current node and human/failure nodes.

### Phase 4 — Live session events

- Subscribe to Pi subagent `session.subscribe()` inside Kanade `WorkflowAgent`.
- Emit compact `workflow.agent_session_event` over existing task SSE.
- Update graph node live summaries.
- Update Agent Live view in near real time.

### Phase 5 — Polish

- Static planned graph preview from workflow AST.
- Branch layout for wide terminals.
- `Open in Pi` for native subagent session viewing.
- Autocomplete for task IDs if needed.
- Optional urgent widget above editor.

## Open questions

- How much of Pi's internal tool rendering should be replicated vs summarized?
- Should Kanade expose absolute subagent session paths over API, or should extension derive them from `KANADE_DIR`?
- How aggressively should SSE payloads be truncated?
- Should graph events be persisted in the DB or reconstructed from task events/snapshot?
- How should parallel branches be laid out in narrow terminals?
