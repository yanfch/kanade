---
name: kanade
description: Use Kanade for multi-agent workflow tasks, generated workflows, background implementation/review/test loops, task monitoring, human gates, iteration, and safe merge/reject decisions from inside Pi.
---

# Kanade

Kanade is a multi-agent workflow runtime. Use it when the user wants a task delegated to a background workflow, especially implementation/review/test loops or generated multi-agent tasks.

## Preferred interface

Use the Kanade CLI as the portable baseline. The skill should work even when the Pi extension is not installed, as long as the `kanade` CLI is available.

Common CLI commands:

```bash
kanade health
kanade ls
kanade ls --status running
kanade show <task-id>
kanade show <task-id> --json
kanade run <workflow> --args '{}'
kanade iterate <task-id> --instructions '...'
kanade workflows
```

Prefer compact CLI or targeted HTTP/JQ commands for monitoring so large JSON does not flood the model context:

```bash
kanade ls --status running
kanade show <task-id> | sed -n '1,120p'
curl -s http://127.0.0.1:7777/tasks/<task-id> | jq '{id:.task.id,status:.task.status,started_at:.task.started_at,error:.task.error}'
tail -n 40 <session.jsonl>
```

Use the `/kanade` cockpit for human-visible inspection and actions when available. Do not depend on project-specific custom tools for normal Kanade operation, and do not add extra slash commands unless the user explicitly asks.

Dangerous actions (`merge`, `reject cleanup`, `abort`) must require explicit user confirmation. Prefer Cockpit/dialog confirmation when available; otherwise ask the user clearly before running CLI commands such as `kanade merge`, `kanade reject`, or abort endpoints.

## Creating tasks

Use Kanade when the user says things like:

- “让 Kanade 做这个”
- “开一个任务”
- “跑一个多 agent workflow”
- “后台执行/审查/测试这个改动”
- “生成一个 workflow 来做这个”

Prefer generated tasks for natural-language work requests. Keep prompts project-agnostic unless the user provides project-specific commands or acceptance criteria.

Portable CLI path:

```bash
kanade run <saved-workflow> --args '{}'
```

For generated natural-language tasks, prefer a portable CLI/API path. If a generated-task CLI command is unavailable in that installation, create or use a saved workflow instead of depending on Pi-specific tools.

Pass prepare commands only when they are explicitly needed or clearly project-appropriate. Do not add heavyweight default prepare commands globally.

## Monitoring tasks

After creating a task:

1. record the task id;
2. monitor status, snapshot/graph, events, and agent sessions;
3. if the task reaches `needs_human`, ask the user through the cockpit/dialog;
4. if the task fails or aborts, preserve and inspect recoverable state before cleanup.

## Merge safety

Never treat `finished` alone as sufficient for merge.

Before merge, inspect or report evidence for:

- generated workflow script and semantic validity;
- workflow graph / actual execution path;
- review and test node outcomes;
- worktree diff and commits;
- checks/evidence if available;
- usage/cost;
- any human decisions.

Merge/reject/abort require explicit user confirmation.

## Failed or aborted tasks

Failed/aborted worktrees are valuable recovery state. Prefer:

1. inspect failed node and agent history;
2. inspect preserved worktree/diff;
3. iterate with new instructions;
4. keep preserved worktree;
5. reject cleanup only after user confirms deletion.

Do not automatically reject cleanup after failure.

## Human gates

If Kanade needs human input:

- summarize the request;
- show available options if any;
- let the user choose or type a custom response;
- submit the response through the Cockpit/dialog after explicit user choice.

Do not silently choose approval/rejection.

## Workflow graph interpretation

Use the workflow graph to explain:

- current node;
- active agent;
- completed nodes;
- review/test feedback;
- why execution looped backward, e.g. `review.status === "needs_fix"`;
- failed node and recovery recommendation.

When graph data is unavailable, fall back to task snapshot, events, and agent session timeline.
