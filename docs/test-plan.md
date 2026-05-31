# 测试规划 & Evaluation 设计

## 1. 当前测试覆盖（155 tests, 10 files）

### 已覆盖

| 模块 | 测试数 | 覆盖内容 | 层级 |
|------|--------|----------|------|
| config | 2 | 加载默认值、合并用户配置 | 单元 |
| journal | 9 | hash 稳定性、读写、缓存命中、human 响应 | 单元 |
| human-gate | 5 | 立即 resolve、已 resolve、poll、abort、非法调用 | 单元 |
| roles | 7 | 加载、schema、default-model | 单元 |
| runtime | 13 | 脚本解析、request_human、缓存复用、agent 参数传递 | 集成(mock agent) |
| workflow-agent | 12 | session 创建、role 过滤、schema override、journal 缓存、isolation | 集成(mock session) |
| workflow-store | 15 | list/get/put/delete、name 校验、meta 解析 | 单元 |
| app (routes) | 37 | 所有 REST 端点 happy path + 404 + 400 + abort + respond | 集成(app.request) |
| isolation-manager | 16 | mode:none、worktree 创建/复用/cleanup、finalize approved/rejected/aborted、stale cleanup | 集成(real git) |
| task-manager | 39 | inline/saved/generated 创建、human 流程、rerun、save、abort、failure、lifecycle events、metadata、list | 集成 |

### 未覆盖（gap）

| 场景 | 原因 |
|------|------|
| agent() 真实执行链路 | 需要 mock pi SDK |
| parallel() 并发执行 | 同上 |
| pipeline() 流式执行 | 同上 |
| SSE 事件流推送到真实客户端 | 需要 HTTP server |
| rerun + journal 缓存复用 | 需要 agent() 先写入 journal |
| abort signal 全链路传播 | 需要 agent() 真实运行中 abort |
| worktree + agent 联动 | 需要 agent() 在 worktree 里执行 |
| token budget 消耗跟踪 | 需要 agent() 消耗 token |

---

## 2. Mock E2E 测试计划

### 设计思路

不 mock runtime 层，只 mock 最底层的 **pi SDK createAgentSession**。

```
真实代码：  TaskManager → runWorkflow → WorkflowAgent → createAgentSession → session.prompt
mock 点：                                                          ↑ 这里
```

这样中间所有代码（脚本解析、sandbox 执行、role 加载、tool 注册、journal 写入、isolation 准备）全部走真实逻辑。

### Mock SDK 行为定义

```typescript
// MockAgentSession：模拟 pi SDK session
class MockAgentSession {
  messages = [{ role: 'assistant', content: [{ type: 'text', text: 'mock result' }] }];
  
  async prompt(text: string) {
    // 记录收到的 prompt
    // 如果有 structured_output tool，自动调用它
    // 模拟 LLM 延迟（可配）
  }
  
  async abort() { this.aborted = true; }
  dispose() {}
}

// MockAgentSessionFactory：根据 prompt 返回不同结果
function createMockSessionFactory(scenarios: Map<string, MockResponse>) {
  return async (options) => {
    // 根据 prompt 匹配 scenario，返回对应结果
    // 支持：纯文本返回、structured_output 调用、tool 调用模拟、错误模拟、延迟模拟
  };
}
```

### 测试用例清单

#### P0 — 核心链路（必须）

| # | 用例 | 脚本 | Mock 行为 | 验证点 |
|---|------|------|-----------|--------|
| E1 | 单 agent 完整执行 | `phase('P'); const r = await agent('task', {schema}); return r` | 返回 structured_output `{ok: true}` | result、journal 写入、events 序列 |
| E2 | parallel 并发 | `const r = await parallel([()=>agent('a'), ()=>agent('b')]); return r` | 两个 agent 各自返回 | 两个都完成、顺序无关、result 正确 |
| E3 | pipeline 流式 | `return await pipeline(items, stage1, stage2)` | stage 返回处理后值 | 每个 item 经过所有 stage |
| E4 | request_human + respond | `const r = await request_human({title}); return r` | — | status=needs_human → respond → finished |
| E5 | agent 失败不崩溃 workflow | `await agent('fail'); return {ok:true}` | agent 抛错 | workflow 继续、result 为 null |
| E6 | rerun + journal 复用 | 跑两遍同一脚本 | 第二次 agent 返回不同值 | 第二次用 journal 缓存、result 同第一次 |

#### P1 — 隔离 & 资源管理

| # | 用例 | Mock 行为 | 验证点 |
|---|------|-----------|--------|
| E7 | worktree 隔离执行 | agent({isolation:'worktree'}) | session.cwd 是 worktree 路径、cleanup 被调用 |
| E8 | 多 agent 不同 worktree | parallel 两个 agent 各自 isolation | 两个不同 cwd、独立 cleanup |
| E9 | reuseBranch 复用 | 同 task 内两次 agent 同 branch | 第二次复用 worktree id |

#### P2 — 错误处理 & 边界

| # | 用例 | Mock 行为 | 验证点 |
|---|------|-----------|--------|
| E10 | abort 中途取消 | agent 延迟 5s，1s 后 abort | status=aborted、signal 传播、session.abort 被调 |
| E11 | token budget 耗尽 | agent 消耗大量 token | 第 N 次 agent 抛 "budget exhausted" |
| E12 | 脚本无 agent 调用 | `return {static: true}` | 正常完成、agentCount=0 |
| E13 | generated 两阶段 | source=generated | author.generate 写脚本 → run 脚本 → 完成 |
| E14 | generated 失败 | author 抛错 | status=failed、无 workflow.js |

#### P3 — 事件流

| # | 用例 | 验证点 |
|---|------|--------|
| E15 | 完整事件序列 | created → script_generated → running → phase → agent_started → agent_completed → finished |
| E16 | 多 agent 事件交错 | parallel 时 agent_started/agent_completed 事件正确配对 |
| E17 | abort 事件 | running → aborted（不是 finished） |
| E18 | failure 事件 | running → failed（含 error） |

---

## 3. 真实 E2E 测试计划（下一步）

在有真实 LLM 访问的环境下执行，验证端到端正确性。

| # | 用例 | 验证点 |
|---|------|--------|
| R1 | 真实 LLM 返回 structured_output | schema 校验通过、result 类型正确 |
| R2 | 真实 LLM 使用 tool | tool 调用链完整、结果正确 |
| R3 | 复杂 workflow（3+ agent、parallel + phase） | 全部完成、phase 正确、无泄漏 |
| R4 | request_human 中断后恢复 | 真实等待 → 真实响应 → 继续执行 |
| R5 | rerun 真实 journal 缓存 | 第二次跑同一脚本、部分 agent 命中缓存 |

---

## 4. Evaluation 体系设计

### 目标

量化 workflow 执行的**能力**和**质量**，不是测代码 bug，而是测 LLM 的任务完成度。

### 维度

| 维度 | 指标 | 计算方式 |
|------|------|----------|
| **完成率** | workflow 完成 / 尝试 | status=finished 的比例 |
| **正确率** | result 符合预期 / 完成 | 对比 expected output |
| **效率** | 平均 agent 调用数 / 任务 | agentCount 统计 |
| **成本** | 平均 token 消耗 / 任务 | budget.spent() |
| **缓存命中** | journal hit / total agent calls | journal hit_count |
| **延迟** | P50/P95 执行时间 | durationMs |

### Eval Case 结构

```typescript
interface EvalCase {
  id: string;
  name: string;
  category: 'code_review' | 'research' | 'refactor' | 'bugfix' | 'feature';
  source: 'saved' | 'inline' | 'generated';
  script?: string;           // inline 时用
  workflow_name?: string;    // saved 时用
  prompt?: string;           // generated 时用
  args?: unknown;
  
  expected: {
    status: 'finished' | 'needs_human';   // 期望终态
    resultSchema?: TSchema;                // result 应符合的 schema
    resultContains?: unknown;              // result 应包含的字段
    maxAgentCalls?: number;                // agent 调用上限
    maxDurationMs?: number;                // 时间上限
    maxTokens?: number;                    // token 上限
    requiredPhases?: string[];             // 必须出现的 phase
  };
  
  scoring: {
    weights: {
      completion: number;    // 完成权重 (0-1)
      correctness: number;   // 正确权重 (0-1)
      efficiency: number;    // 效率权重 (0-1)
    };
  };
}
```

### Eval Suite 示例

```typescript
const EVAL_SUITE: EvalCase[] = [
  {
    id: "E001",
    name: "simple return",
    category: "bugfix",
    source: "inline",
    script: `export const meta = { name: 'test', description: 'Test' }
const r = await agent('return {ok:true}', { label: 'fix', schema: { type:'object', properties:{ok:{type:'boolean'}}, required:['ok'] } })
return r`,
    expected: {
      status: "finished",
      resultContains: { ok: true },
      maxAgentCalls: 1,
      maxDurationMs: 30_000,
    },
    scoring: { weights: { completion: 0.3, correctness: 0.5, efficiency: 0.2 } },
  },
  {
    id: "E002",
    name: "parallel fan-out",
    category: "research",
    source: "inline",
    script: `export const meta = { name: 'fanout', description: 'Fan-out' }
const results = await parallel(['a','b','c'].map(item => () => agent('process ' + item, { label: item })))
return { count: results.length, items: results }`,
    expected: {
      status: "finished",
      resultContains: { count: 3 },
      maxAgentCalls: 3,
    },
    scoring: { weights: { completion: 0.4, correctness: 0.4, efficiency: 0.2 } },
  },
  // ... 更多 case
];
```

### 评分逻辑

```typescript
interface EvalResult {
  caseId: string;
  passed: boolean;
  score: number;           // 0-1
  breakdown: {
    completion: number;    // 0 or 1
    correctness: number;   // 0-1
    efficiency: number;    // 0-1
  };
  metrics: {
    agentCalls: number;
    durationMs: number;
    tokensUsed: number;
    journalHits: number;
  };
  error?: string;
}

function scoreCase(case_: EvalCase, result: WorkflowRunResult, metrics: RunMetrics): EvalResult {
  const completion = result.status === case_.expected.status ? 1 : 0;
  
  let correctness = 0;
  if (completion === 1) {
    if (case_.expected.resultContains) {
      correctness = deepContains(result.result, case_.expected.resultContains) ? 1 : 0;
    } else {
      correctness = 1; // 无断言则默认正确
    }
  }
  
  let efficiency = 1;
  if (case_.expected.maxAgentCalls) {
    efficiency = Math.min(1, case_.expected.maxAgentCalls / metrics.agentCalls);
  }
  
  const { weights } = case_.scoring;
  const score = completion * weights.completion
              + correctness * weights.correctness
              + efficiency * weights.efficiency;
  
  return {
    caseId: case_.id,
    passed: score >= 0.8,
    score,
    breakdown: { completion, correctness, efficiency },
    metrics,
  };
}
```

### 输出报告

```
┌─────────────────────────────────────────────────────────────────┐
│                    Kanade Evaluation Report                      │
│                    2026-05-30 14:30:00                           │
├─────────────────────────────────────────────────────────────────┤
│ Total: 20 cases    Passed: 17    Failed: 3    Score: 0.87       │
├─────────────────────────────────────────────────────────────────┤
│ By Category:                                                     │
│   bugfix      6/6  ████████████ 100%                            │
│   research    4/5  ████████░░░░  80%  ← E012 failed             │
│   refactor    3/4  ██████░░░░░░  75%  ← E015 timeout            │
│   feature     4/5  ████████░░░░  80%  ← E018 wrong result       │
├─────────────────────────────────────────────────────────────────┤
│ Top Issues:                                                      │
│   E012 research  fan-out 10 items: only 7 completed (timeout)   │
│   E015 refactor  large file: exceeded 60s limit                 │
│   E018 feature   schema mismatch: missing 'files' field         │
├─────────────────────────────────────────────────────────────────┤
│ Performance:                                                     │
│   Avg duration:  12.3s   P50: 8.1s   P95: 45.2s                │
│   Avg tokens:    45,200  Avg agents: 3.2                        │
│   Cache hit rate: 0% (first run)                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. 实施顺序

| 阶段 | 内容 | 产出 | 状态 |
|------|------|------|------|
| **Phase 1** | Mock E2E 框架 + P0 用例 (E1-E6) | `test/e2e-mock/` | ✅ |
| **Phase 2** | P1-P2 用例 (E7-E14) | 补充到同目录 | 75% (E9/E10/E11 缺) |
| **Phase 3** | P3 事件流用例 (E15-E18) | 补充到同目录 | 75% |
| **Phase 4** | Eval 框架 + 初始 eval suite (10 cases) | `eval/` | ✅ |
| **Phase 5** | 真实 E2E 用例 (R1-R5) | `test/e2e-real/` | 40% (R3/R4/R5 缺) |
| **Phase 6** | 扩充 eval suite 到 30+ cases | 持续迭代 | ❌ |

### Phase 4 实现细节

- `eval/types.ts` — EvalCase/EvalResult/EvalReport/RunMetrics 类型
- `eval/scorer.ts` — 评分逻辑（completion/correctness/efficiency），17 单元测试
- `eval/reporter.ts` — 终端彩色表格报告
- `eval/runner.ts` — 执行器（支持 mock 和真实 LLM 两种模式）
- `eval/suites/default.ts` — 10 cases（bugfix/research/refactor/feature/code_review）
- `eval/run.ts` — 入口脚本
- `npm run eval` — mock 模式（零成本，秒级）
- `npx tsx eval/run.ts` — 真实 LLM 模式（~$0.30/次）
