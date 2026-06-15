# Generated Live Smoke

Date: 2026-06-15

## Purpose

This smoke validates Kanade as an IDE-style generated workflow harness on a real but disposable repository.

It uses:

- real workflow author
- real workflow subagents
- a temporary git fixture repository
- Kanade worktree isolation
- local acceptance checks in the generated worktree

It does **not** modify the Kanade source repository.

## Command

```bash
npm run smoke:generated-live -- \
  --author-model xiaomi/mimo-v2.5-pro \
  --agent-model xiaomi/mimo-v2.5-pro \
  --timeout-ms 1800000 \
  --poll-ms 5000
```

## Fixture task

The script creates a temporary Node.js repository with:

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
task=GLS-0001 status=finished recommendation=accept
author=xiaomi/mimo-v2.5-pro
agent=xiaomi/mimo-v2.5-pro
semanticWorkflowOk=true
agentCalls=2
checks=npm test:pass
reasons=none
```

Diff summary:

```text
README.md             | 2 +-
src/greeting.js       | 2 +-
test/greeting.test.js | 2 +-
3 files changed, 3 insertions(+), 3 deletions(-)
```

Raw local artifacts were written under ignored `eval-artifacts/generated-live-smoke/<timestamp>/`, including:

```text
workflow.js
summary.json
summary.txt
diff.patch
```

The temporary root was retained for inspection after the run.

## Interpretation

This confirms the next quality layer beyond author eval and mocked generated workflow smoke:

1. `xiaomi/mimo-v2.5-pro` authored an executable workflow.
2. Real subagents executed against an isolated worktree.
3. The task completed successfully.
4. The generated changes were committed in the worktree.
5. `npm test` passed in the worktree.
6. Evidence was collected without touching the Kanade repository.
