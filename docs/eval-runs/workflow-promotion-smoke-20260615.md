# Workflow Promotion Smoke

Date: 2026-06-15

## Purpose

This smoke validates the Kanade workflow sedimentation loop:

```text
generated workflow -> successful run -> save workflow -> run saved workflow on a fresh fixture repo
```

It uses:

- real workflow author: `xiaomi/mimo-v2.5-pro`
- real workflow subagents: `xiaomi/mimo-v2.5-pro`
- two temporary git fixture repositories
- Kanade worktree isolation
- local `npm test` acceptance checks in both generated and saved worktrees

It does **not** modify the Kanade source repository.

## Current save trigger

Workflow save is currently exposed through:

```http
POST /tasks/:id/save { "name": "workflow_name" }
```

and the CLI:

```bash
kanade save <task-id> --as <workflow-name>
```

Internally this calls:

```ts
TaskManager.save(taskId, name)
```

which copies the task's `workflow.js` into:

```text
<KANADE_DIR>/workflows/<name>.js
```

## Command

```bash
npm run smoke:workflow-promotion -- \
  --author-model xiaomi/mimo-v2.5-pro \
  --agent-model xiaomi/mimo-v2.5-pro \
  --timeout-ms 1800000 \
  --poll-ms 5000
```

## Fixture task

Both fixture repositories contain:

```text
package.json
README.md
src/greeting.js
test/greeting.test.js
```

The generated task asks the agents to:

```text
Update greet() to return exactly "Hello, Kanade!".
Update README.md to document the new greeting output.
Update the focused test expectation.
Run npm test.
```

## 2026-06-15 result

```text
workflow=generated_greeting_update promotion=ok recommendation=accept
author=xiaomi/mimo-v2.5-pro
agent=xiaomi/mimo-v2.5-pro
reasons=none

PASS generated task=WPS-0001 status=finished agents=2 checks=npm test:pass
PASS saved     task=WPS-0002 status=finished agents=2 checks=npm test:pass
```

Generated run diff summary:

```text
README.md              | 2 +-
src/greeting.js        | 2 +-
test/greeting.test.js  | 2 +-
validation-result.json | 5 +++++
4 files changed, 8 insertions(+), 3 deletions(-)
```

Saved run diff summary:

```text
README.md             | 2 +-
src/greeting.js       | 2 +-
test/greeting.test.js | 2 +-
3 files changed, 3 insertions(+), 3 deletions(-)
```

Raw local artifacts were written under ignored `eval-artifacts/workflow-promotion-smoke/<timestamp>/`, including:

```text
generated.workflow.js
generated.diff.patch
saved.workflow.js
saved.diff.patch
summary.json
summary.txt
```

## Interpretation

This confirms that a useful generated workflow can be promoted into the saved workflow library and reused on a fresh repository fixture.

This is the third Kanade IDE-harness confidence layer after:

1. author eval
2. generated workflow runtime smoke
3. generated live smoke

Together they validate that Kanade can generate, execute, review, preserve, and now sediment reusable workflows.
