# 测试规划

## 当前覆盖：302 tests, 17 files

### 单元测试 (50)

| 模块 | Tests | 覆盖 |
|------|-------|------|
| config | 2 | 加载、合并 |
| journal | 9 | hash、读写、缓存 |
| human-gate | 5 | resolve、poll、abort |
| roles | 7 | 加载、schema |
| tracing | 7 | exporter、logger |
| workflow-agent persistence | 7 | 持久化、filter、sanitize |
| workflow-agent retry | 4 | 重试、abort、exhausted |
| cleanup-scheduler | 13 | worktree/journal/trace 清理 |
| announcer | 15 | dispatch、fallback、probe |
| eval/scorer | 17 | completion/correctness/efficiency |

### 集成测试 (204)

| 模块 | Tests | 覆盖 |
|------|-------|------|
| runtime | 27 | 脚本解析、request_human、cache_lead、parallel |
| workflow-agent | 23 | session、role、isolation、retry |
| app (routes) | 37 | REST 端点 |
| task-manager | 43 | lifecycle、iterate、rerun、abort |
| workflow-store | 15 | CRUD |
| isolation-manager | 21 | worktree、merge、cleanup |
| snapshot-builder | 10 | agent/phase 事件追踪 |
| misc | 28 | config、journal、roles、tracing |

### E2E (40)

| 分类 | Tests | 覆盖 |
|------|-------|------|
| 核心链路 | 16 | agent、parallel、pipeline、human、failure、cache |
| Worktree | 5 | 隔离、cleanup、reuseBranch |
| Session 持久化 | 6 | 持久化、filter、API |
| Snapshot | 5 | lifecycle、parallel、failure、API |
| Cleanup | 3 | scheduler、journal、traces |
| Iterate | 1 | 迭代链 |
| 其他 | 4 | abort、token budget、events |

## Eval 框架

```
eval/
├── types.ts          # EvalCase, EvalResult
├── scorer.ts         # 评分逻辑 (17 tests)
├── reporter.ts       # 终端报告
├── runner.ts         # 执行器
├── run.ts            # 入口
└── suites/
    └── default.ts    # 10 cases
```

```bash
npm run eval              # mock 模式
npx tsx eval/run.ts       # 真实 LLM (~$0.30)
```

## 运行

```bash
npm test                        # 全部 294
npx vitest run test/e2e-mock/   # E2E
npx vitest run src/server/      # Server
npx vitest run eval/scorer*     # Eval scorer
```

## Live generated-task acceptance harness

Use the harness against a running Kanade server to submit a generated task and collect acceptance evidence before deciding whether to merge.

`--prepare-command` (`options.prepare_commands` over the task API) and `--check` are user/project-chosen shell commands. They are not global defaults; each repository should pass commands relevant to its own stack.

### Project-agnostic examples (non-exhaustive)

**Java / Maven project:**

```bash
npm run live:accept -- \
  --prompt "Update the Java scheduler error handling..." \
  --prepare-command "./mvnw -q -DskipTests dependency:go-offline" \
  --check "./mvnw test"
```

**Java / Gradle project:**

```bash
npm run live:accept -- \
  --prompt "Update the Java service validation path..." \
  --prepare-command "./gradlew --version" \
  --check "./gradlew test"
```

**Python project:**

```bash
npm run live:accept -- \
  --prompt "Fix the Python CLI argument parsing edge case..." \
  --prepare-command "python -m pip install -r requirements.txt" \
  --check "python -m pytest"
```

**Rust project:**

```bash
npm run live:accept -- \
  --prompt "Update the Rust parser behavior..." \
  --prepare-command "cargo fetch" \
  --check "cargo test"
```

**Go project:**

```bash
npm run live:accept -- \
  --prompt "Update the Go API handler behavior..." \
  --prepare-command "go mod download" \
  --check "go test ./..."
```

Kanade (Node/TypeScript) repository-specific `isolation.prepareCommands` defaults can also be set globally as:

```yaml
isolation:
  prepareCommands:
    - "npm install"
    - "npm run test"
```

### Kanade self-development examples (Node/TypeScript, not universal defaults)

```bash
npm run live:accept -- \
  --base-url http://127.0.0.1:7781 \
  --author-model gpt-5.4 \
  --agent-model gpt-5.3-codex-spark \
  --role-model reviewer=gpt-5.4 \
  --prompt "Small focused Kanade task..." \
  --prepare-command "npm install" \
  --prepare "npm install" \
  --check "npm run typecheck" \
  --check "npm run lint"
```

The report checks task status, semantic workflow validation, result status, worktree commit/dirty state, main workspace dirty state, usage, optional task-level worktree preparation commands, and optional local checks. A `finished` task is still only a candidate; inspect the generated workflow and worktree diff before merging.

Each run writes a machine-readable evidence report to `<run_dir>/acceptance-evidence.json` by default, or to `--evidence-file PATH` when specified. The evidence report includes `schemaVersion`, `generatedAt`, the submitted prompt, task launch options, task response, generated workflow script, worktree diff stats/patches, usage, checks, and the final recommendation.

Live acceptance now emits v2 evidence sections for review:
- `workflowSummary`: regex-extracted ordered phases and helper call counts (`analyze`, `implement`, `reviewChange`, `continueImplementation`, `testChange`, `request_human`, `parallel`) plus `hasImplementation/hasReview/hasValidation/hasFixLoop`.
- `worktreeDiffs`: per-worktree short `HEAD`, changed file list, diff stat, and diff patch from the worktree path.
- `evidence.usage`, `evidence.result`, and `evidence.worktrees`: includes zero-usage and at-least-one-worktree-commit flags.
- recommendation logic: only `accept` when finished + semantic-ok + no failed validation + at least one clean worktree commit + clean main/worktrees + pass prepare/checks; `reject` for failed/aborted/needs_human, semantic invalid, dirty worktrees, or failed prepare/checks; otherwise `inspect`.

## Generated workflow acceptance checks

These checks ensure that LLM-generated workflows remain safe and correct:

1. **Semantic-only output** – Generated workflows must contain only high-level, semantic instructions (e.g., task description, goals, acceptance criteria). They must not include implementation-level details that bypass the platform's execution layer.

2. **Validation rejects raw agent/pipeline constructs** – The workflow validation layer must reject any generated workflow that includes raw `agent`, `pipeline`, or other low-level execution controls. This prevents the LLM from injecting unsafe or uncontrolled execution paths.

3. **Quality gates are explicit** – Generated workflows must follow the V1 quality gates:
   - `reviewChange` with `status: 'approved'` means no blocking issues remain.
   - reviewer-reported issues must trigger one `continueImplementation` fix pass.
   - `testChange` on medium/complex tasks must return `status: 'passed'` or `status: 'failed'`, using `issues` only for blocking validation failures and `warnings` for non-blocking notes.
   - validation failures must follow `Fix validation` then `Re-validate` (a second `testChange` pass after one `continueImplementation` fix iteration).

4. **Worktree auto-commit failures abort the task** – If a worktree auto-commit operation fails, the task must transition to a failed state immediately. The system must not report a misleading "finished" status when the commit (and thus the deliverable) did not succeed.

5. **Isolated-agent coding tools use worktree cwd** – Coding tools (bash, file read/write, edit) dispatched to isolated agents must execute against the effective worktree working directory, not the server or main-repo cwd.

6. **Deterministic workspace profile snapshot is advisory for generated prompts** – Generation must derive a project profile using only deterministic filesystem marker existence checks under the task root (no command execution or AST parsing). The snapshot is injected into the author prompt as context only and is user-overridable; unknown/marker-less repos must not receive forced stack defaults.
