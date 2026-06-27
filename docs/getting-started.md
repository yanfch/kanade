# Getting started

This guide is the CLI-only first-run path. You do **not** need Pi or the optional `/kanade` cockpit to use Kanade.

## 1. Install

```bash
git clone https://github.com/yanfch/kanade.git
cd kanade
npm install

# Optional, but convenient: put `kanade` on PATH for this checkout.
npm link
```

If you skip `npm link`, replace `kanade ...` commands below with `npm run cli -- ...`.

## 2. Configure models

Kanade needs a model configuration. Choose one path.

### Option A: inherit Pi settings

Use this if Pi is installed and already has providers/auth configured:

```yaml
# ~/.kanade/config.yml
models:
  mode: inherit-pi
  inheritPiSettings: true
```

### Option B: explicit Kanade model files

Use this if you want Kanade to use explicit auth/model files instead of Pi inheritance:

```yaml
# ~/.kanade/config.yml
models:
  mode: kanade
  authPath: /absolute/path/to/auth.json
  modelsPath: /absolute/path/to/models.json

defaults:
  authorModel: your-author-model
  agentModel: your-agent-model
```

See [configuration.md](configuration.md) for the full config reference.

## 3. Start the server

```bash
kanade start --daemon
kanade health
```

Expected health output should indicate the server is reachable, for example:

```text
Kanade server is healthy
```

If port `7777` is busy, use a separate directory and port:

```bash
kanade start --dir /tmp/kanade-dev --port 7778 --daemon
kanade --url http://127.0.0.1:7778 health
```

## 4. Run a safe first task

Start with a read-only repository inspection task:

```bash
kanade run --prompt "Inspect this repository and summarize its test commands. Do not modify files." --follow
```

This should print a task id such as `T-0001`, stream task events, and eventually finish or fail with an error message.

Check task state:

```bash
kanade ls
kanade show T-0001
```

A successful first run proves that:

- the server is running;
- model credentials work;
- Kanade can create and monitor tasks;
- agent sessions can execute.

## 5. If a task needs input

Some workflows can pause at a human gate:

```bash
kanade inbox
kanade respond <task-id> --request <request-id> --decision approve
```

Do not approve blindly. Read the request and choose the appropriate decision.

## 6. Iterate safely

If the first result needs refinement:

```bash
kanade iterate T-0001 --instructions "Clarify the test command summary and mention any missing setup steps."
kanade show T-0002
```

Iteration passes previous context into the next task and may reuse the same branch/worktree where appropriate.

## 7. Running modifying tasks

For code-changing work, be explicit and review before merging:

```bash
kanade run --prompt "Add retry handling to the API client and update relevant tests." --follow
kanade show <task-id>
```

Before merge, inspect:

- task result;
- workflow/review summary;
- worktree diff and commits;
- checks/test evidence;
- any human-gate decisions.

Only then merge:

```bash
kanade merge <task-id>
```

## 8. Recovery and cleanup

Failed or aborted worktrees are preserved by default. Prefer inspection and iteration before cleanup:

```bash
kanade show <failed-task-id>
kanade iterate <failed-task-id> --instructions "Inspect the preserved worktree, recover useful work, and continue."
```

Clean up only when you intentionally want to discard preserved work:

```bash
kanade reject <failed-task-id>
```

## 9. Optional Pi cockpit

If you use Pi, this repository includes an optional cockpit extension:

```text
.pi/extensions/kanade/
.pi/skills/kanade/
```

In Pi, trust the project, run `/reload`, then `/kanade`.

The CLI remains the baseline interface. The skill content in `.pi/skills/kanade/SKILL.md` can be copied into other coding agents and composed with project-specific skills.
