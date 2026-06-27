# Configuration

Kanade reads configuration from `~/.kanade/config.yml` by default. Override the data directory with `KANADE_DIR` or `kanade start --dir <path>`.

## Minimal config

```yaml
models:
  mode: inherit-pi
  inheritPiSettings: true

defaults:
  concurrency: 16
  maxConcurrentTasks: 0        # 0 = unlimited

isolation:
  defaultMode: worktree
  defaultBaseBranch: develop
  autoCleanupOnReject: false
  autoCleanupOnAbort: false

cleanup:
  enabled: true
  schedule: "0 * * * *"

announcers: []
```

## Full example

```yaml
models:
  # inherit-pi uses Pi's model/auth settings when Kanade is run from the same machine.
  # "pi" is accepted as a shorthand alias.
  mode: inherit-pi
  agentDir: null
  authPath: null
  modelsPath: null
  inheritPiSettings: true
  disableSubagentCompaction: true

network:
  httpProxy: null      # e.g. http://127.0.0.1:1087
  httpsProxy: null
  allProxy: null       # e.g. socks5://127.0.0.1:1080
  noProxy: null
  httpIdleTimeoutMs: 300000

defaults:
  authorModel: openai-codex:gpt-5.4
  agentModel: xiaomi/mimo-v2.5-pro
  roleModels:
    developer: xiaomi/mimo-v2.5-pro
    tester: xiaomi/mimo-v2.5-pro
    reviewer: openai-codex:gpt-5.4
  tokenBudget: 2000000
  concurrency: 16
  maxConcurrentTasks: 0        # 0 = unlimited
  agentTimeoutMs: 1800000

isolation:
  defaultMode: worktree
  defaultBaseBranch: develop
  branchPrefix: kanade
  worktreeBaseDir: null
  # Preserve failed/aborted task worktrees for inspection and recovery.
  # Use `kanade reject <task-id>` only after explicitly confirming cleanup.
  autoCleanupOnReject: false
  autoCleanupOnAbort: false
  prepareCommands:
    - "npm install"
    - "npm run lint -- --no-fix"

merge:
  targetBranch: develop
  useNoFf: true
  requireCleanLint: true
  requireCleanTest: true

debug:
  dumpArtifacts: false
  persistSubagents: false

cleanup:
  enabled: true
  schedule: "0 * * * *"
  journalRetentionDays: 30

liveAcceptance:
  prepare:
    - "npm install"
  checks:
    - "npm run typecheck"
    - "npm run lint"
    - "npm test -- --exclude '.tmp/**'"
  timeoutMs: 1800000
  pollMs: 10000

announcers: []
```

## Environment variables

```text
KANADE_DIR    Server data directory. Default: ~/.kanade
KANADE_URL    CLI target URL. Default: http://127.0.0.1:7777
```

Examples:

```bash
KANADE_DIR=/tmp/kanade-dev kanade start --port 7778 --daemon
KANADE_URL=http://127.0.0.1:7778 kanade ls
```

## Running multiple instances

Each instance should use a separate data directory and port:

```bash
kanade start --dir ~/.kanade --port 7777 --daemon
kanade start --dir /tmp/kanade-dev --port 7778 --daemon
kanade --url http://127.0.0.1:7778 ls
```

Each directory owns its own SQLite state, config, runs, worktrees, logs, traces, and saved workflows.

## Models

`models.mode: inherit-pi` is the easiest local setup when Pi already has model providers configured. You can also set explicit paths:

```yaml
models:
  mode: kanade
  authPath: /path/to/auth.json
  modelsPath: /path/to/models.json
  agentDir: /path/to/agent-dir
```

Use `defaults.authorModel` for generated workflow authoring and `defaults.agentModel` for general agent execution. `defaults.roleModels` can override model selection by role.

## Isolation and recovery

The recommended public default is worktree isolation with preserved failed/aborted worktrees:

```yaml
isolation:
  defaultMode: worktree
  autoCleanupOnReject: false
  autoCleanupOnAbort: false
```

This makes failures recoverable. Inspect the worktree and agent history first, then iterate or explicitly clean up.

Dangerous cleanup commands should be user-confirmed:

```bash
kanade show <task-id>
kanade iterate <task-id> --instructions "Recover useful work and continue"
kanade reject <task-id>   # only when cleanup is intended
```

## Prepare commands

Use `isolation.prepareCommands` for commands that should run when preparing task worktrees:

```yaml
isolation:
  prepareCommands:
    - "npm install"
    - "npm run typecheck"
```

Use CLI `--prepare-command` for one-off task-specific preparation:

```bash
kanade run --prompt "..." --prepare-command "npm install" --prepare-command "npm run typecheck"
```

## Announcers

Announcers send notifications for selected task events. Example HTTP/TTS-style announcer:

```yaml
announcers:
  - name: task-complete
    type: tsutae_tts
    url: http://127.0.0.1:1338/v1/speak
    events: [task.finished]
    body_template: "Task {{task.id}} finished."
    enabled: true
```

## Live acceptance harness

`liveAcceptance` stores defaults for `npm run live:accept`:

```yaml
liveAcceptance:
  prepare:
    - "npm install"
  checks:
    - "npm run typecheck"
    - "npm run lint"
    - "npm test -- --exclude '.tmp/**'"
  timeoutMs: 1800000
  pollMs: 10000
```

CLI flags override config defaults for a single run.
