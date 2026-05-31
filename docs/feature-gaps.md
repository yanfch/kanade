# 功能清单

## 状态

```
核心功能 ██████████████████████████████████ 100%
质量保障 ████████████████████████████████░░  95%
```

**294 tests · 40 E2E · CI green ✅**

## 已完成

| # | Feature | 文件 | Tests |
|---|---------|------|-------|
| 1 | Tracing / OTLP | `tracing/` | 7 |
| 2 | CLI 客户端 | `bin/kanade.ts` | — |
| 3 | Merge 工作流 | `isolation/` | 21 |
| 4 | Subagent Session 持久化 | `workflow-agent.ts` | 13 |
| 5 | Artifact Dump | `runtime.ts` | — |
| 6 | CleanupScheduler | `cleanup-scheduler.ts` | 15 |
| 7 | Subagent 读取路由 | `app.ts` | — |
| 8 | Parallel cache_lead | `runtime.ts` | 7 |
| 9 | Announcer 框架 | `announcer.ts` | 15 |
| 10 | Snapshot 实时更新 | `snapshot-builder.ts` | 13 |
| 11 | LLM WorkflowAuthor | `workflow-author.ts` | — |
| 12 | Eval 框架 | `eval/` | 17 |
| 13 | Error Recovery (retry) | `workflow-agent.ts` | 4 |
| 14 | Rate Limiting | `task-manager.ts` | — |
| 15 | Iterate API | `task-manager.ts` + `state-store.ts` | 5 |
| 16 | Worktree cleanup 验证 | `e2e.test.ts` | 2 |

## 剩余

| # | 任务 | 类型 | 工作量 |
|---|------|------|--------|
| R3 | 复杂 workflow 真实 E2E | 测试 | 半天 |
| R4 | request_human 中断恢复 真实 E2E | 测试 | 半天 |
| R5 | rerun journal 缓存 真实 E2E | 测试 | 半天 |
| — | 扩充 eval suite 到 30+ cases | 测试 | 2-3 天 |

全部是测试补全，核心功能已完成。
