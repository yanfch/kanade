# Pi Kanade Cockpit UI Spec

This document defines the visual and interaction design for the Pi Kanade Cockpit described in:

- `docs/pi-kanade-cockpit-design.md`
- `docs/pi-kanade-cockpit-implementation-plan.md`
- `docs/pi-kanade-cockpit-theme.md`
- `docs/pi-kanade-cockpit-animations.md`

## Design goal

The cockpit should feel like a polished terminal control room, not a raw log viewer.

## Adopted visual baseline

Use the final **quiet cockpit** mockup as the implementation baseline:

- muted border frame, not bright cyan frame;
- most text is gray/normal;
- selected/current markers use cyan;
- human attention and review `needs_fix` use yellow/warning;
- true task failure/destructive cleanup uses red/error;
- completed nodes use a green `✓` icon only, not a green row;
- workflow graph is vertical first;
- Agent Live uses a timestamp column and a quiet activity stream;
- Recovery Center treats preserved worktree as an asset, with only destructive delete colored red.

Avoid returning to the earlier high-saturation dashboard style.

It should make these questions obvious within seconds:

1. Which Kanade tasks need attention?
2. Where is a workflow currently executing?
3. Which agent is currently active?
4. Why did execution loop back after review/test?
5. What action should the user take next?

## TUI capability baseline

Pi extensions can build this with:

- `ctx.ui.custom(..., { overlay: true })` for floating panels;
- `ctx.ui.setStatus()` for footer status;
- `ctx.ui.setWidget()` for rare urgent inline reminders;
- `SelectList`, `SettingsList`, `Text`, `Container`, custom components from `@earendil-works/pi-tui`;
- keyboard handling via `matchesKey()` and `Key.*`;
- theme colors from the provided `theme` callback.

Recommended references:

- Pi docs: `docs/tui.md`
- Pi examples:
  - `examples/extensions/preset.ts` — selector + border framing
  - `examples/extensions/tools.ts` — settings/toggle list
  - `examples/extensions/qna.ts` — loader + editor flow
  - `examples/extensions/question.ts` — custom selection/editor UI
  - `examples/extensions/overlay-test.ts` — overlay behavior
  - `examples/extensions/status-line.ts` — footer status
- Pi internal components for inspiration only, not stable imports:
  - session selector
  - tree selector
  - tool execution rows
  - assistant/tool message components

Do **not** deep-import Pi internal interactive components in the first version. Recreate compact summaries with public TUI primitives.

## UI layers

### 1. Footer status

Always visible, very small.

Examples:

```text
K: ● connected · ▶1 · ?0 · ✖0
K: ? T-0049 waiting for you
K: offline
```

Rules:

- Never show long text in footer.
- If any human request exists, footer prioritizes it.
- If disconnected, show `K: offline` in error color.

### 2. Urgent widget

Normally absent.

Only show above/below editor for urgent attention:

```text
Kanade needs input: T-0049 Review decision  · run /kanade
```

Rules:

- No full task list in widget.
- No persistent noisy widget when there is no urgent state.

### 3. Overlay cockpit

Primary UI, opened by `/kanade`.

Use overlay rather than replacing the whole Pi conversation permanently.

Recommended overlay options:

```ts
{
  overlay: true,
  overlayOptions: {
    width: "90%",
    maxHeight: "85%",
    margin: 1,
  }
}
```

## Visual language

### Icons

```text
● connected
◌ reconnecting
✖ offline / failed
▶ running
? needs human
✓ done / finished
⚑ aborted
○ planned / queued / pending
↺ loop / retry / back edge
│ vertical flow
▼ next node
├ branch
╰/╭ panel frame
```

### Semantic colors

Use Pi theme tokens only.

| Meaning | Theme token |
|---|---|
| main accent / selected | `accent` |
| success / done | `success` |
| warning / needs human / preserved worktree | `warning` |
| error / failed | `error` |
| secondary info | `muted` |
| low priority / hints | `dim` |
| normal text | `text` |

Do not hardcode ANSI colors except through the injected theme.

### Density

Default view should be compact.

- One selected task = detailed.
- Other tasks = 2-line cards.
- Graph nodes = 2-4 lines each.
- Full logs/output only after expanding.

## Main cockpit layout

### Wide layout

Use split panes when width >= ~100 columns.

```text
╭─ Kanade Cockpit ─────────────────────────────────────────────────────╮
│ ● connected  http://127.0.0.1:7777       ▶ 1 running  ? 1 ask  ✖ 1 failed │
├───────────────────────────────┬──────────────────────────────────────┤
│ Tasks                         │ T-0048  ▶ running                    │
│                               │ Add Pi Kanade cockpit                │
│ ▸ ? T-0049 Review decision    │                                      │
│     needs_human · waiting     │ [Map] Agent Events Worktree Usage    │
│   ▶ T-0048 Pi extension       │                                      │
│     running · 8m · $0.18      │  ✓ 1 Analyze                         │
│   ✖ T-0039 Usage failed       │      plan ready · 3 findings         │
│     failed · preserved        │       │                              │
│   ✓ T-0042 Usage accounting   │       ▼                              │
│     finished · 2h ago         │  ✓ 2 Implement                       │
│                               │      changed 4 files · commit 9ac12ef│
│                               │       │                              │
│                               │       ▼                              │
│                               │  ✖ 3 Review                          │
│                               │      needs_fix · 2 blocking issues   │
│                               │       │ needs_fix: missing author cost│
│                               │       ▼                              │
│                               │  ▶ 4 Continue Implementation          │
│                               │      live: ✏️ edit task-manager.ts    │
├───────────────────────────────┴──────────────────────────────────────┤
│ ↑↓ select · Enter detail/actions · Tab tab · r refresh · Esc close    │
╰──────────────────────────────────────────────────────────────────────╯
```

### Narrow layout

Use stacked layout when width < ~100 columns.

```text
╭─ Kanade Cockpit ─────────────────────────╮
│ ● connected   ▶1 ?1 ✖1                   │
├──────────────────────────────────────────┤
│ Tasks                                    │
│ ▸ ? T-0049 Review decision               │
│     needs_human · waiting                │
│   ▶ T-0048 Pi extension                  │
│     running · 8m                         │
├──────────────────────────────────────────┤
│ T-0049  ? needs_human                    │
│ [Map] Agent Events Worktree Usage        │
│                                          │
│ ? Human Approval                         │
│   Review decision                        │
│                                          │
│ Action: Respond                          │
├──────────────────────────────────────────┤
│ ↑↓ select · Tab tabs · Enter actions     │
╰──────────────────────────────────────────╯
```

## Task list design

### Attention priority

Sort tasks by:

1. `needs_human`
2. failed/aborted with preserved worktree
3. running
4. recent finished
5. created/old tasks

### Task card

Selected:

```text
▸ ? T-0049 Review decision
    needs_human · reviewer · waiting for you
```

Unselected:

```text
  ▶ T-0048 Add Pi extension panel
    running · implement · 8m · $0.18
```

Failed preserved:

```text
  ✖ T-0039 Usage task failed
    failed · worktree preserved · timed out
```

Rules:

- Task title should truncate gracefully.
- Error should be short in list, full in detail.
- Cost/time are optional; hide if unavailable.

## Detail tabs

Tabs:

```text
Map | Agent | Events | Worktree | Usage | Result
```

Render active tab as `[Map]` with accent/bold.

Default tab:

| Task state | Default tab |
|---|---|
| running | Map |
| needs_human | Map, highlight human node |
| failed/aborted | Map, highlight failed node |
| finished | Map |

## Workflow Map design

The map is the cockpit's primary view.

It has two modes:

1. **Planned graph** — dim, best-effort preview from workflow script.
2. **Runtime graph** — authoritative actual execution path.

Runtime graph wins over planned graph.

### MVP vertical graph

Use vertical timeline first.

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

### Wide branch graph later

Use only when width is sufficient.

```text
Analyze → Implement → Review ─approved→ Test
                        │
                        └needs_fix→ Continue ─↺ Review
```

### Node display

A node should show:

```text
<icon> <seq> <kind/name>
    <summary or current activity>
```

Examples:

```text
✓ 2 Implement
    changed 4 files · commit 9ac12ef
```

```text
✖ 3 Review
    needs_fix · 2 blocking issues
```

```text
▶ 4 Continue Implementation
    live: 📖 read src/server/task-manager.ts
```

```text
? 5 Human Approval
    waiting: Merge this task?
```

### Edge display

Edges should explain control flow.

Simple sequence:

```text
 │
 ▼
```

Decision:

```text
 │ needs_fix: 2 blocking issues
 ▼
```

Loop:

```text
 └────────↺ returns to Review
```

### Review/test feedback

Review/test nodes should show enough detail to explain decisions.

Collapsed:

```text
✖ 3 Review
    needs_fix · 2 blocking issues
```

Expanded:

```text
Review result
- Blocking: usage.total only counts runtime usage
- Blocking: CLI labels journal cache as Agent Calls

Next edge
needs_fix → Continue Implementation
Reason: review.status === "needs_fix"
```

### Human node

Collapsed:

```text
? 5 Human Approval
    waiting: Review decision
```

Expanded/actions:

```text
Question
Merge this task?

> Approve
  Need changes
  Reject
  Type custom response...
```

### Failed node

Collapsed:

```text
✖ 4 Continue Implementation
    timeout after 600000ms
```

Expanded:

```text
Failure
Agent Implement agent 2 timed out after 600000ms

Recovery
- View agent history
- Inspect preserved worktree
- Iterate with instructions
- Keep worktree
- Reject cleanup only if confirmed
```

## Agent tab design

The Agent tab answers: what did the selected/active agent actually do?

### Agent list + preview

```text
Agents
▸ Implement agent 2   running    38 entries
  Review agent 1      done       needs_fix
  Implement agent 1   done       changed 4 files

Timeline
[think] Need to patch usage aggregation...
[read]  src/server/task-manager.ts
        ✓ 820 lines
[edit]  src/server/task-manager.ts
        +26 -4
[bash ⣾] npm run typecheck
        running 18s...
```

### Tool row labels

Default: no emoji, use stable text labels.

```text
[think] assistant thinking
[text]  assistant text
[bash]  shell command
[read]  file read
[edit]  edit/write
[find]  grep/find/ls
[out]   structured_output
[err]   tool error
```

Running tool uses braille dots:

```text
[bash ⣾] npm run typecheck
```

Emoji can be a later optional style, but must not be the default because terminal width varies.

### Expanded tool result

Default collapsed:

```text
[bash] npm run typecheck
       ✓ exit 0 · 4.2s · 12 lines
```

Expanded:

```text
[bash] npm run typecheck
────────────────────────
> kanade@0.0.1 typecheck
> tsc --noEmit

✓ exit 0
```

## Events tab

Raw but compact SSE event list.

```text
17:22:10 task.running
17:22:11 workflow.phase        Implement
17:23:04 workflow.agent_started Implement agent 1
17:31:18 workflow.agent_completed Implement agent 1
17:32:01 workflow.graph_edge_created needs_fix → continue
17:33:02 task.needs_human      Review decision
```

Rules:

- Keep this as diagnostic view.
- Do not make it the primary UX.

## Worktree tab

For completed/failed tasks, show code state.

```text
Worktree
Path    /Users/yanfch/.kanade/worktrees/T-0048
Branch  kanade/T-0048
Status  preserved
Commit  9ac12ef

Files
M src/server/task-manager.ts
M src/bin/kanade.ts
A .pi/extensions/kanade/index.ts

Recommendation
Inspect diff and checks before merge.
```

Failed/aborted:

```text
Worktree preserved for recovery

Recommended:
1. View failed node / agent history
2. Inspect diff
3. Iterate with new instructions
4. Keep preserved worktree
5. Reject cleanup only when you want deletion
```

## Usage tab

```text
Usage & Cost
Author Cost    $0.08
Agent Cost     $0.34
Total Cost     $0.42
Total Tokens   128k

By node / agent
Implement agent 1    $0.18   52k
Review agent 1       $0.09   31k
Validate agent 1     $0.07   20k
```

If per-agent usage is not available yet, show task total and a dim note.

## Result tab

Show structured result summary.

For JSON, show compact pretty print, truncated by default.

```text
Result
{
  "status": "passed",
  "summary": "Implemented Pi cockpit skeleton...",
  "filesChanged": [
    ".pi/extensions/kanade/index.ts",
    ".pi/skills/kanade/SKILL.md"
  ]
}
```

## Action menu

Press Enter on a task/node to open contextual actions.

```text
╭─ Actions for T-0048 ───────────────╮
│ > View active agent live           │
│   View workflow result             │
│   Iterate with instructions        │
│   Abort task                       │
│   Close                            │
╰────────────────────────────────────╯
```

Actions vary by state.

### Running

```text
View active agent live
View events
View snapshot
Abort task
```

### Needs human

```text
Respond
Inspect graph
View agent history
Iterate with instructions
Abort task
```

### Finished

```text
Inspect graph
Inspect worktree
Merge
Iterate with instructions
Reject cleanup
```

### Failed/aborted

```text
View failed node
View agent history
Inspect preserved worktree
Iterate with instructions
Keep
Reject cleanup
```

## Confirmation dialogs

### Merge

```text
╭─ Confirm merge ─────────────────────────╮
│ Merge T-0048 into main?                 │
│                                         │
│ Only merge after inspecting workflow,   │
│ graph, diff, checks, evidence, usage,   │
│ and human decisions.                    │
│                                         │
│ [Cancel] [Merge]                        │
╰─────────────────────────────────────────╯
```

### Abort

```text
╭─ Abort task ────────────────────────────╮
│ Abort T-0048?                           │
│                                         │
│ Current worktree/branch will be         │
│ preserved for inspection/recovery.      │
│                                         │
│ [Cancel] [Abort]                        │
╰─────────────────────────────────────────╯
```

### Reject cleanup

```text
╭─ Cleanup preserved worktree ────────────╮
│ Reject T-0039 and remove worktree/branch? │
│                                         │
│ This deletes preserved partial work.    │
│                                         │
│ [Keep] [Delete]                         │
╰─────────────────────────────────────────╯
```

## Human response dialog

With options:

```text
╭─ Human request: T-0049 ─────────────────╮
│ Merge this task?                        │
│                                         │
│ > Approve                               │
│   Need changes                          │
│   Reject                                │
│   Type custom response...               │
╰─────────────────────────────────────────╯
```

Custom editor:

```text
╭─ Respond to T-0049 ─────────────────────╮
│ Instructions / decision:                │
│                                         │
│ 需要修改 usage 展示，再跑 typecheck。     │
│                                         │
│ Enter submit · Esc cancel               │
╰─────────────────────────────────────────╯
```

## Keyboard model

Global inside cockpit:

| Key | Action |
|---|---|
| `↑/↓` | move selection |
| `tab` | next tab |
| `shift+tab` | previous tab if implemented |
| `enter` | open detail/action |
| `r` | refresh |
| `f` | follow/live mode if available |
| `e` | expand/collapse selected item |
| `esc` | back/close |
| `?` | help overlay if implemented |

Keep shortcuts visible in footer hints.

## Responsive rules

- Width < 80: show compact stacked layout, hide less important metadata.
- Width 80-119: stacked or narrow split depending on content.
- Width >= 120: split layout with task list + detail.
- Never output lines wider than render width.
- Always use `truncateToWidth()` for dynamic strings.

## Implementation notes

- Start with custom components returning `{ render, invalidate, handleInput }`.
- Cache rendered lines by width, invalidate on state changes.
- Use theme from `ctx.ui.custom()` callback only.
- Avoid long raw outputs in default view.
- Build compact summaries from task/snapshot/session data.
- Full content should require expansion/drill-down.

## MVP visual acceptance checklist

- `/kanade` looks intentional, not like raw JSON.
- Task status is understandable at a glance.
- Needs-human task is visually prominent.
- Failed preserved task recommends recovery, not cleanup.
- Running task shows workflow map placeholder or actual map.
- Agent tab can summarize session history once implemented.
- Dialogs make dangerous actions feel deliberate.
- Narrow terminal remains usable.
