# Pi Kanade Cockpit Theme and Style Guide

This guide defines how the Kanade Cockpit should look inside Pi.

It complements:

- `docs/pi-kanade-cockpit-design.md`
- `docs/pi-kanade-cockpit-ui-spec.md`
- `docs/pi-kanade-cockpit-implementation-plan.md`

A project-local Pi theme is provided at:

```text
.pi/themes/kanade-cockpit.json
```

Use it in Pi via `/settings` → theme → `kanade-cockpit`, or by setting Pi's theme config.

## Theme philosophy

The extension should not require a custom theme to function. It must respect the user's active Pi theme.

However, the cockpit should be designed around a stable visual grammar. The important rule is **quiet by default, colored only for meaning**:

- most text is normal text or muted gray;
- borders are muted, not neon;
- cyan is only for selected/current/live focus;
- green is mostly for completion icons, not whole rows;
- yellow is only for human attention, review feedback, preserved worktree warnings;
- red is only for failures and destructive actions;
- dim gray is for hints and inactive planned nodes.

Do not color every label. If everything is colored, nothing is important.

## Provided palette

`kanade-cockpit` uses a dark, slightly blue terminal palette inspired by quiet Tokyo Night-style contrast.

| Role | Color |
|---|---|
| base background | `#14161b` |
| panel | `#1a1d24` |
| soft panel | `#20242d` |
| selection | `#253044` |
| accent/cyan | `#7dcfff` |
| blue | `#7aa2f7` |
| purple/loop | `#bb9af7` |
| success green | `#9ece6a` |
| error red | `#f7768e` |
| warning yellow | `#e0af68` |
| text | `#c0caf5` |
| muted | `#7f849c` |
| dim | `#565f89` |

## Pi theme token mapping

Use only Pi's theme API in extension code:

```ts
theme.fg("accent", text)
theme.fg("success", text)
theme.fg("warning", text)
theme.fg("error", text)
theme.fg("muted", text)
theme.fg("dim", text)
theme.bold(text)
```

Do not hardcode ANSI escape sequences in the extension.

Semantic mapping:

| Cockpit concept | Pi token | Scope |
|---|---|---|
| selected task/node | `accent` + bold | prefix/title only |
| live/running | `accent` | spinner/current tool only |
| done/completed | `success` | icon only, sometimes short status word |
| needs human / warning / preserved worktree | `warning` | icon and reason only |
| failed / destructive action | `error` | icon/action label only |
| normal labels | `text` | default body text |
| metadata | `muted` | most secondary text |
| inactive/planned/help | `dim` | planned graph/hints |
| borders | `borderMuted` mostly, `borderAccent` rarely | frame/dividers |

Recommended ratio in a normal screen:

- 70% text/muted/dim;
- 20% borders/structure;
- 10% semantic color.

## Status icons and colors

| State | Icon | Color |
|---|---|---|
| connected | `●` | success |
| reconnecting | `◌` | warning/muted |
| offline | `✖` | error |
| running | `▶` | accent |
| needs human | `?` | warning |
| finished/done | `✓` | success |
| failed | `✖` | error |
| aborted | `⚑` | error/warning |
| pending/planned | `○` | dim |
| loop/back edge | `↺` | accent or muted |

If terminal emoji rendering is unreliable, prefer ASCII-safe icons:

```text
[run] [ask] [ok] [fail] [hold] [loop]
```

The MVP should use ASCII-safe symbols where possible:

```text
● ▶ ? ✓ ✖ ⚑ ○ ↺ │ ▼
```

## Layout style

### Borders

Use light line borders for screenshots and wide layouts:

```text
╭─ Kanade Cockpit ─────────╮
│ content                  │
╰──────────────────────────╯
```

In implementation, if line width/terminal issues appear, fall back to simpler borders:

```text
Kanade Cockpit
────────────────
content
────────────────
```

The current MVP extension can start border-light and become framed later.

### Pane dividers

Use a dim vertical divider:

```text
left pane │ right pane
```

Color with `theme.fg("dim", "│")`.

### Selection

Selected task:

```text
▸ ? T-0049 Review decision
    needs_human · reviewer · waiting for you
```

Style:

- `▸` in accent;
- `?` in warning;
- task id/title in normal text, title can be bold only when selected;
- metadata line muted/dim;
- avoid coloring the whole first line unless the screen feels too flat.

If using `selectedBg`, keep text readable and avoid multi-line background complexity until later.

## Typography rules

### Titles

Use bold accent:

```text
Kanade Cockpit
Tasks
Runtime Workflow
Agent Live
```

### Metadata

Use muted or dim:

```text
running · 8m · $0.18
worktree preserved · timed out
```

### Hints

Use dim:

```text
↑↓ select · Enter actions · Tab tabs · r refresh · Esc close
```

### Dangerous text

Use error for destructive action labels and failure summaries:

```text
Reject cleanup deletes preserved partial work.
```

### Recovery recommendations

Use warning for recommendation header, muted for details:

```text
Recommended: inspect agent history/worktree, iterate, or keep.
```

## Workflow Map style

Vertical graph first:

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
    live: edit src/server/task-manager.ts
     │
     └────────↺ returns to Review
```

Color rules:

- node icon colored by state;
- node title stays normal text unless selected/current;
- summaries muted;
- edge labels warning only when they explain a problem (`needs_fix`, `failed`);
- loop marker muted/purple, not bright unless selected;
- planned nodes dim.

Do not color entire completed nodes green. Use a green `✓` and keep the text quiet.

Selected node example:

```text
▶ 4 Continue Implementation
    live: ✏ edit src/server/task-manager.ts
```

Style selected node title in accent + bold.

## Agent timeline style

Compact rows:

```text
[think] Need to patch usage aggregation...
[read]  src/server/task-manager.ts        ✓ 820 lines
[edit]  src/server/task-manager.ts        +26 -4
[bash]  npm run typecheck                 running 18s
[out]   structured_output                 status: needs_fix
```

Use emoji only if width is reliable:

```text
🧠 📖 ✏️ 🔧 ✅
```

MVP should prefer ASCII tags:

```text
[think] [read] [edit] [bash] [out]
```

Color rules:

- active/running tool prefix: accent;
- successful result icon/check only: success;
- error result icon/action only: error;
- paths/commands: text;
- counts/durations: muted;
- output preview: dim/muted.

Avoid coloring whole tool rows. Tool timelines should read like a log with small status beacons.

## Dialog style

Use simple framed modals.

### Merge confirmation

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

Style:

- title accent;
- warning text warning;
- destructive confirm label error only for reject cleanup, not merge;
- selected button accent.

### Reject cleanup confirmation

```text
╭─ Cleanup preserved worktree ────────────╮
│ Reject T-0039 and remove worktree/branch? │
│                                         │
│ This deletes preserved partial work.    │
│                                         │
│ [Keep] [Delete]                         │
╰─────────────────────────────────────────╯
```

Style `Delete` with error.

## Spacing

- Prefer one blank line between conceptual sections.
- Avoid more than two consecutive blank lines.
- Keep task cards two lines.
- Keep collapsed graph nodes two lines plus edge line.
- Expand only on demand.

## Truncation

Every dynamic line must pass through `truncateToWidth()`.

Rules:

- task title can truncate aggressively;
- error summaries should truncate in list, full in detail;
- file paths can compact home directory to `~` later;
- session output should be summarized, not dumped.

## Theme usage in extension code

Recommended helper layer:

```ts
type CockpitTheme = {
  title: (s: string) => string;
  selected: (s: string) => string;
  live: (s: string) => string;
  done: (s: string) => string;
  warn: (s: string) => string;
  fail: (s: string) => string;
  meta: (s: string) => string;
  dim: (s: string) => string;
};

function cockpitTheme(theme): CockpitTheme {
  return {
    title: (s) => theme.fg("accent", theme.bold(s)),
    selected: (s) => theme.fg("accent", s),
    live: (s) => theme.fg("accent", s),
    done: (s) => theme.fg("success", s),
    warn: (s) => theme.fg("warning", s),
    fail: (s) => theme.fg("error", s),
    meta: (s) => theme.fg("muted", s),
    dim: (s) => theme.fg("dim", s),
  };
}
```

This keeps styling consistent and makes it easy to adjust later.

## Screenshot/wireframe prompt add-on

When asking ChatGPT to draw TUI mockups, include this style direction:

```text
Visual style: dark cockpit terminal UI, cyan active accent, green success, yellow human/warning, red failure/destructive, blue-gray muted metadata. Use thin box borders, compact two-line task cards, vertical workflow graph, selected row with ▸, and footer key hints. Avoid busy tables. Make it look like a polished terminal control room.
```
