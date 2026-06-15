# Workflow Author Eval: mimo-v2.5-pro vs gpt-5.4

Date: 2026-06-15

## Command

```bash
npm run eval:author -- \
  --models xiaomi/mimo-v2.5-pro,openai-codex:gpt-5.4 \
  --variants=semantic-no-read \
  --cases=S4,S5,M4,M7,C4,C7
```

## Local raw artifacts

Raw generated workflows, prompts, score JSON, and terminal output were saved locally under:

```text
eval-artifacts/workflow-author/compare-mimo-gpt54-20260615-143506
```

`eval-artifacts/` is intentionally ignored by git; this document records the durable summary in the repository.

## Results

```text
Total: 12/12 pass

xiaomi/mimo-v2.5-pro   avg=0.992 pass=6/6 sizeFit=6/6 raw=0/6
openai-codex:gpt-5.4   avg=0.975 pass=6/6 sizeFit=6/6 raw=0/6
```

Case observations:

| Case | Coverage | Result |
| --- | --- | --- |
| S4 | simple docs/text cleanup | tie, both 1.000 |
| S5 | no-code recovery summary | tie, both 1.000 |
| M4 | risky config auth gate | mimo better; gpt-5.4 omitted expected `analyze` |
| M7 | Cockpit usage display refinement | gpt-5.4 slightly better; mimo added a light extra `analyze` |
| C4 | merge readiness review center | tie, both 1.000 |
| C7 | settings editor architecture | tie, both 1.000 |

## Interpretation

This eval only checks the workflow author output structure; it does not execute implementation/review/test subagents.

For this representative comparison, `xiaomi/mimo-v2.5-pro` is a strong default workflow author:

- pass rate matched gpt-5.4
- average score was slightly higher
- all outputs fit requested workflow size
- no raw `agent()` / `pipeline()` fallback
- generated scripts parsed successfully

Recommended default remains:

```text
author: xiaomi/mimo-v2.5-pro
```

Use `openai-codex:gpt-5.4` occasionally as an author benchmark for complex or high-risk prompts.
