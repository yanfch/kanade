# 测试规划

## 当前覆盖：294 tests, 16 files

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

## Generated workflow acceptance checks

These checks ensure that LLM-generated workflows remain safe and correct:

1. **Semantic-only output** – Generated workflows must contain only high-level, semantic instructions (e.g., task description, goals, acceptance criteria). They must not include implementation-level details that bypass the platform's execution layer.

2. **Validation rejects raw agent/pipeline constructs** – The workflow validation layer must reject any generated workflow that includes raw `agent`, `pipeline`, or other low-level execution controls. This prevents the LLM from injecting unsafe or uncontrolled execution paths.

3. **Worktree auto-commit failures abort the task** – If a worktree auto-commit operation fails, the task must transition to a failed state immediately. The system must not report a misleading "finished" status when the commit (and thus the deliverable) did not succeed.

4. **Isolated-agent coding tools use worktree cwd** – Coding tools (bash, file read/write, edit) dispatched to isolated agents must execute against the effective worktree working directory, not the server or main-repo cwd.
