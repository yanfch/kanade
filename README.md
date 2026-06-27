# kanade（奏）

> CLI-first multi-agent workflow runtime for coding tasks.

Kanade runs a local server plus `kanade` CLI. You describe a task, Kanade runs a workflow of agents, preserves recoverable worktrees, lets you iterate, and only merges when you explicitly decide.

<p align="center">
  <img src="docs/assets/kanade-cockpit.png" alt="Kanade Cockpit in Pi" width="860">
</p>

## What it does

- Run generated, saved, or inline JavaScript workflows.
- Orchestrate agents with phases, review/test loops, `parallel(...)`, and `request_human(...)` gates.
- Keep task state in SQLite and stream progress through CLI/HTTP events.
- Isolate code-changing work in Git worktrees; preserve failed/aborted work for recovery.
- Iterate from previous results and reuse branches/worktrees when appropriate.
- Use the optional Pi `/kanade` cockpit for visual task inspection; the CLI is the baseline and does not require Pi.

Kanade is currently a public-preview project. APIs and workflow conventions may still change.

## First run: CLI-only onboarding

Requirements: Node.js 22+, Git, and model/provider configuration. Pi is optional.

```bash
git clone https://github.com/yanfch/kanade.git
cd kanade
npm install
npm link              # optional, puts `kanade` on PATH
```

Create a minimal config if you want to inherit existing Pi model settings:

```yaml
# ~/.kanade/config.yml
models:
  mode: inherit-pi
  inheritPiSettings: true
```

Start the server:

```bash
kanade start --daemon
kanade health
```

Run a safe read-only first task:

```bash
kanade run --prompt "Inspect this repository and summarize its test commands. Do not modify files." --follow
kanade ls
kanade show <task-id>
```

If the result needs refinement:

```bash
kanade iterate <task-id> --instructions "Clarify the test command summary and mention any missing setup steps."
```

For code-changing work, review before merge:

```bash
kanade run --prompt "Add retry handling to the API client and update relevant tests." --follow
kanade show <task-id>
kanade merge <task-id>      # only after reviewing diff/checks/result
```

For a more detailed first-run path, including explicit non-Pi model config, see [docs/getting-started.md](docs/getting-started.md).

## Optional Pi cockpit and portable skill

Kanade ships a project-local Pi extension and skill:

```text
.pi/extensions/kanade/   # optional /kanade cockpit UI
.pi/skills/kanade/       # CLI-first agent guidance
```

If you use Pi, trust the project, run `/reload`, then `/kanade`.

The skill is portable: copy `.pi/skills/kanade/SKILL.md` into other coding agents and compose it with project-specific skills. It is intentionally CLI/HTTP-first and does not require the Pi extension.

## Documentation

- [Getting started](docs/getting-started.md) — first-run setup, safe first task, iteration, recovery.
- [Configuration](docs/configuration.md) — full `~/.kanade/config.yml` reference.
- [CLI and HTTP API](docs/cli-api.md) — command and endpoint reference.
- [Contributing](CONTRIBUTING.md) — development workflow and checks.
- [Security](SECURITY.md) — security reporting and local automation safety model.

## Development

```bash
npm run lint
npm run typecheck
npm test
npm run smoke:pi-kanade
npm run eval
```

## License and notices

Kanade is MIT licensed. See [LICENSE](LICENSE).

Portions of `src/workflow-engine/` are derived from [`pi-dynamic-workflows`](https://github.com/Michaelliv/pi-dynamic-workflows), MIT licensed. See [NOTICE.md](NOTICE.md).
