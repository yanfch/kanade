# Pi Kanade Cockpit Animation Guide

This guide defines lightweight terminal animations for the Kanade Cockpit.

Reference inspiration:

- https://terminal-craft.vercel.app/

Terminal Craft provides glyph animation ideas such as spinners, throbbers, progress indicators, agentic feeds, thinking indicators, and tool feed prefixes. Treat it as visual inspiration and a source of small frame arrays when licensing/attribution allows. Do not add a runtime dependency just for glyph animation.

Default cockpit style: **no emoji**. Use braille dots and ASCII-like labels for stable terminal width and a quiet cockpit feel.

## Principles

Animations should make state easier to understand, not distract.

Rules:

- Animate only live/running/attention states.
- Completed/failed states should be static.
- Keep animations low-frequency: 100–250ms per frame.
- Avoid large moving blocks in the main panel.
- Use ASCII-safe fallbacks for terminals with poor emoji width handling.
- Respect Pi's theme; color through `theme.fg(...)`, not raw ANSI.

## Where to animate

### 1. Header connection pulse

Connected static:

```text
● connected
```

Reconnecting animation:

```text
◌ reconnecting
○ reconnecting
◌ reconnecting
```

Offline static:

```text
✖ offline
```

### 2. Running task icon

Use a small spinner for running tasks.

Default braille dots frames:

```ts
const KANADE_SPINNER = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
const KANADE_SPINNER_INTERVAL_MS = 200;
```

Fallback:

```ts
const ASCII_SPINNER = ["-", "\\", "|", "/"];
```

Example:

```text
⣾ T-0048 Pi extension
  running · implement · 8m
```

### 3. Active workflow node

Only the current node animates.

```text
⣾ 4 Continue Implementation
    live: [edit] src/server/task-manager.ts
```

Static states:

```text
✓ 2 Implement
✖ 3 Review
○ 5 Test
```

### 4. Active edge pulse

Use sparingly, only in focused Map view.

Frames:

```text
 │
 ▼
```

can alternate with:

```text
 ╎
 ▾
```

Do not animate every edge. Only animate edge out of the currently running node if useful.

### 5. Agent thinking/feed

Thinking row:

```text
[think] pondering…
[think] contemplating…
[think] got it…
```

Tool feed prefix:

```text
[read]  src/server/task-manager.ts
[edit]  src/server/task-manager.ts
[bash]  npm run typecheck
```

Use animated prefix only for active tool:

```text
[bash ⣾] npm run typecheck
```

Completed tool:

```text
[bash ✓] npm run typecheck   exit 0 · 4.2s
```

Failed tool:

```text
[bash ✖] npm run typecheck   exit 1
```

### 6. Progress dots

For unknown duration operations:

```ts
const DOTS = ["", ".", "..", "..."];
```

Example:

```text
Generating workflow...
```

## Implementation pattern in Pi TUI

Use component-local tick state.

```ts
class AnimatedPanel {
  private tick = 0;
  private timer: NodeJS.Timeout;

  constructor(private tui: { requestRender(): void }) {
    this.timer = setInterval(() => {
      this.tick++;
      this.invalidate();
      this.tui.requestRender();
    }, 140);
  }

  close() {
    clearInterval(this.timer);
  }

  render(width: number): string[] {
    const frame = SPINNER[this.tick % SPINNER.length];
    return [`${frame} running`];
  }

  invalidate() {}
}
```

When using `ctx.ui.custom()`, clear timers when closing:

```ts
await ctx.ui.custom((tui, theme, _kb, done) => {
  const panel = new AnimatedPanel(tui);
  const close = () => {
    panel.close();
    done(undefined);
  };
  panel.onClose = close;
  return panel;
}, { overlay: true });
```

If the panel refreshes from SSE/polling, animation tick and data refresh are separate:

- animation timer: ~120–180ms;
- task polling fallback: 1–3s;
- footer status polling: 10s;
- SSE updates: immediate.

## Global Pi working indicator

Pi also supports:

```ts
ctx.ui.setWorkingIndicator({ frames, intervalMs });
```

Use this only to customize Pi's global agent spinner, not the Kanade cockpit panel. The cockpit should animate inside its own component.

## Recommended frame sets

### Spinner

```ts
export const KANADE_SPINNER = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
export const KANADE_SPINNER_INTERVAL_MS = 200;
```

### Dots

```ts
export const DOTS = ["", ".", "..", "..."];
```

### Pulse

```ts
export const PULSE = ["·", "•", "●", "•"];
```

### Edge

```ts
export const EDGE_ACTIVE = ["│", "╎"];
export const ARROW_ACTIVE = ["▼", "▾"];
```

### ASCII fallback

```ts
export const ASCII_SPINNER = ["-", "\\", "|", "/"];
export const ASCII_PULSE = [".", "o", "O", "o"];
```

## Style rules

- Running spinner: `accent`.
- Reconnecting pulse: `warning`.
- Failed icon: static `error`.
- Done icon: static `success`.
- Pending/planned: static `dim`.
- Human waiting: static or slow pulse `warning`; avoid aggressive blinking.

## MVP choices

For the first working cockpit:

- animate running task icon with `KANADE_SPINNER`;
- animate active workflow node icon with `KANADE_SPINNER`;
- animate active tool prefix in Agent Live with `KANADE_SPINNER`;
- use no emoji by default;
- no animated borders;
- no full-screen marquee effects;
- no heavy background animation.

This is enough to make the cockpit feel alive without hurting readability.
