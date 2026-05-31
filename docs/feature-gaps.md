# 功能缺口清单

> 设计文档 (gui-tui/docs/) 要求 vs 当前实现

## 状态总览

```
已完成 ██████████████████████████████████ 100%
```

---

## P0 — 必须完成（阻塞真实使用）

### 1. Tracing / OTLP

**现状**: `src/tracing/index.ts` 空桩  
**设计**: `docs/04-tracing.md`

需要实现：
- `FileSpanExporter` — span 序列化为 OTLP-JSON，每行一个 JSON
- `setupTracing(config)` — 创建 NodeTracerProvider，注册 exporter
- 接入点：task 生命周期、agent 调用、LLM 调用

**工作量**: 2-3 天

### 2. CLI 客户端

**现状**: `src/bin/kanade.ts` 空桩  
**设计**: `src/bin/README.md` + `docs/10-isolation.md §CLI 命令汇总`

需要实现的命令：
- `kanade ls [--status=<state>]` — 列任务
- `kanade show <task-id>` — 详情
- `kanade tail <task-id>` — SSE 事件流
- `kanade inbox` — 待人工任务
- `kanade respond <task-id> --decision <...>` — 回应
- `kanade abort <task-id>` — 中止
- `kanade merge <task-id>` — 合并 worktree
- `kanade reject <task-id>` — 拒绝
- `kanade worktrees` — 列 worktree
- `kanade run <name> [--args]` — 运行 saved workflow
- `kanade save <task-id> --as <name>` — 保存脚本

所有命令走 HTTP，不直连 DB。用 `node:util.parseArgs`。

**工作量**: 3-4 天

### 3. Merge 工作流

**现状**: 无  
**设计**: `docs/10-isolation.md §确认机制`

需要实现：
- `merge.ts` — checkout develop → merge --no-ff → 跑 lint/test → 成功则删 branch，失败则 reset
- `kanade merge <task-id>` CLI 命令
- `POST /tasks/:id/merge` API（可选）

**工作量**: 1-2 天

---

## P1 — 重要功能（影响开发体验）

### 4. Subagent Session 持久化 ✅

**已完成**: `workflow-agent.ts` + `runtime.ts` + `task-manager.ts` + `app.ts`
- `WorkflowAgentOptions` 新增 `persistSubagents` / `persistFilter` / `persistDir` 选项
- `shouldPersistSession()` + `createSessionManager()` 判断逻辑
- 持久化时用 `SessionManager.create(cwd, labelDir)` 替代 `inMemory()`
- 目录: `runs/<task>/debug/subagents/<label>/<uuid>.jsonl`
- API: `GET /tasks/:id/sessions` + `GET /tasks/:id/sessions/:label`
- 配置: `config.yml` 的 `debug.persistSubagents` + `debug.persistFilter`
- 测试: 7 单元测试 + 6 E2E 测试

**工作量**: 已完成

### 5. Artifact Dump ✅

**已完成**: `runtime.ts` 中 `dumpArtifact()` 函数已实现
- agent 完成后自动写入 `runs/<task>/debug/artifacts/<seq>-<label>.json`
- `dumpArtifacts` 配置项已接入 `task-manager.ts`
- GET `/tasks/:id/artifacts` 和 `/tasks/:id/artifacts/:name` 路由已就绪

**工作量**: 已完成

### 6. CleanupScheduler ✅

**已完成**: `src/server/cleanup-scheduler.ts` + `src/server/index.ts`
- `CleanupScheduler` 类：后台定时执行清理任务
- `parseScheduleToMs()`：解析 cron 表达式为毫秒间隔
- 清理 stale worktrees（调用 `IsolationManager.cleanupStaleWorktrees`）
- 清理过期 `journal.db`（按 mtime 判断）
- 清理过期 trace 目录（按目录名日期判断，跳过 `current`）
- 接入 `startServer()`，shutdown 时 stop()
- 测试：13 单元测试 + 2 E2E 测试

**工作量**: 已完成

### 7. Subagent 读取路由

**现状**: 无  
**设计**: `docs/02-orchestrator.md §REST`

```
GET /tasks/:id/sessions           → subagent session 列表
GET /tasks/:id/sessions/:label    → 读单个 session jsonl
```

**工作量**: 半天

---

## P2 — 增强功能（可后续迭代）

### 8. Parallel Cache 优化 ✅

**已完成**: `runtime.ts`
- `parallel(thunks, { cache_lead: true })` — 先跑第一个建 cache，再并行跑其余
- `cache_lead: false` 或省略 — 纯并行（向后兼容）
- 测试：7 单元测试（含行为验证）

**使用方式**:
```js
// 手动 hint — 当你知道所有 agent 同 role/model 时
const reviews = await parallel(
  files.map(f => () => agent(`Review ${f}`, { role: 'reviewer' })),
  { cache_lead: true }
)
```

**工作量**: 已完成

### 9. Announcer 框架 ✅

**已完成**: `src/server/announcer.ts` + `src/server/index.ts`
- `AnnouncerRegistry`：config 驱动的 announcer 注册表
- 支持 `http_post` / `macos_notification` / `tts_local` 三种类型
- fallback 链：primary 失败自动尝试下一个
- `probe()` 启动时探测 `enabled: auto` 的 HTTP announcers
- template 变量：`{{task.id}}`, `{{event.type}}`, `{{event.summary}}`
- 接入 EventBus，fire-and-forget 不阻塞主流程
- 测试：15 单元测试

**工作量**: 已完成

### 10. Snapshot 实时更新 ✅

**已完成**: `src/workflow-engine/snapshot-builder.ts` + `src/server/app.ts`
- `SnapshotBuilder`：事件驱动的 workflow 进度追踪器
- 订阅 EventBus 事件（agent_started, agent_completed, phase）
- Runtime 零改动——完全通过事件解耦
- Log 事件不触发 snapshot 更新（性能优化）
- API: `GET /tasks/:id/snapshot`
- 测试：10 单元测试 + 3 E2E 测试

**工作量**: 已完成

### 11. 真实 LLM WorkflowAuthor 集成 ✅

**已完成**: `src/server/workflow-author.ts` + `test/real-llm/`
- `LlmWorkflowAuthor` 用 pi SDK 创建 session + structured_output 获取脚本
- `TaskManager.resolveAuthor()` 有 auth 时用 LLM，无 auth 时 fallback 到 stub
- 真实 LLM 测试: `test/real-llm/test-generated.ts` + `test/real-llm/smoke.ts`
- Prompt guidelines: `workflow-engine/prompt-guidelines.ts`

**工作量**: 已完成

---

## 已知 Bug

| # | 描述 | 位置 | 优先级 | 状态 |
|---|------|------|--------|------|
| B1 | `finalizeWorktrees` catch 里 `decision = aborted ? "aborted" : "aborted"`，失败的 task 也被当 aborted | task-manager.ts:366 | 🔴 | ✅ 已修复 |
| B2 | `finalizeWorktrees` approved 路径的 else 分支会删除 worktree dir，即使 `autoCleanupOnAbort=false` | isolation-manager.ts:65 | 🔴 | ✅ 已修复 |
| B3 | `IsolationManager` 忽略 `config.worktreeBaseDir`，用 `baseRepo/..` 计算路径 | isolation-manager.ts:108 | 🟡 | ✅ 已修复 |
| B4 | `IsolationManager` 忽略 `config.defaultBaseRepo`，fallback 到 `process.cwd()` | isolation-manager.ts:99 | 🟡 | ✅ 已修复 |

---

## 建议实施顺序

```
Week 1:  ~~B1 + B2 bug fix → Tracing → Artifact Dump~~ ✅ 已完成
Week 2:  ~~CLI 客户端~~ ✅ → Subagent Session 持久化 + Session 路由
Week 3:  CleanupScheduler + Mock E2E 测试框架完善
Week 4:  Eval 框架 + 初始 eval suite
Week 5:  真实 LLM 端到端测试
```
