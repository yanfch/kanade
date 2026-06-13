---
name: kanade
description: Use Kanade for multi-agent workflow tasks, generated workflows, background implementation/review/test loops, task monitoring, human gates, iteration, and safe merge/reject decisions from inside Pi.
---

# Kanade

Kanade is a multi-agent workflow runtime. Use it when the user wants a task delegated to a background workflow, especially implementation/review/test loops or generated multi-agent tasks.

## Preferred interface

When available, use Kanade extension tools instead of shelling out to the CLI.

Available non-destructive tools:

- `kanade_status` — inspect server health, task counts, top tasks, and pending human requests.
- `kanade_task_detail` — inspect one task, including usage, snapshot, worktrees, sessions, and optional compact subagent session preview.
- `kanade_create_task` — create a generated background task. This starts work but does not merge, abort, reject, or respond to human gates.

Use the `/kanade` cockpit for human-visible inspection and actions. Do not add extra slash commands unless the user explicitly asks.

Dangerous actions (`merge`, `reject cleanup`, `abort`) must go through explicit user confirmation in Cockpit/dialogs. Do not implement or call hidden dangerous tools for these actions.

## Creating tasks

Use Kanade when the user says things like:

- “让 Kanade 做这个”
- “开一个任务”
- “跑一个多 agent workflow”
- “后台执行/审查/测试这个改动”
- “生成一个 workflow 来做这个”

Prefer generated tasks for natural-language work requests. Keep prompts project-agnostic unless the user provides project-specific commands or acceptance criteria.

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
