# Generated Workflow Smoke Harness

Date: 2026-06-15

## Purpose

This smoke harness validates the Kanade generated-workflow path end to end without letting subagents modify real code.

It exercises:

1. generated task creation
2. workflow author output persistence
3. semantic workflow validation
4. runtime execution
5. phase and agent events
6. `agent_calls` persistence
7. task result/evidence reporting

The harness supports two modes:

- deterministic author + mock subagents: offline pipeline smoke
- real author + mock subagents: validates real workflow author output can execute through Kanade runtime

Subagents are mocked in both modes, so this is not an implementation-quality test. It proves the generated workflow structure and runtime path are executable.

## Commands

Offline deterministic author:

```bash
npm run smoke:generated-workflow
```

Real author with mocked subagents:

```bash
npm run smoke:generated-workflow -- \
  --author-model xiaomi/mimo-v2.5-pro \
  --timeout-ms 900000
```

Optional single case:

```bash
npm run smoke:generated-workflow -- \
  --author-model xiaomi/mimo-v2.5-pro \
  --case small-docs
```

## Cases

| Case | Size | Coverage |
| --- | --- | --- |
| `small-docs` | small | implement + focused validation |
| `medium-review` | medium | implement + review + validation |
| `large-architecture` | large | analyze + implement + review + validation |

## 2026-06-15 result

Real author run:

```text
mode=real-author author=xiaomi/mimo-v2.5-pro
pass=3/3

PASS small-docs status=finished agents=2
PASS medium-review status=finished agents=3
PASS large-architecture status=finished agents=4
```

The run confirmed that `xiaomi/mimo-v2.5-pro` can generate executable semantic workflows for the representative small/medium/large cases, and Kanade can run those generated workflows through the normal task lifecycle.

Raw local output was written under ignored `eval-artifacts/generated-workflow-smoke/<timestamp>/`.
