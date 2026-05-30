# tracing

OpenTelemetry 三信号统一：Traces + Logs + Metrics。

## 架构

```
kanade 应用层
    │
    │  tracer.startSpan() / logger.info() / meter.record()
    │
    ▼
OTel SDK (NodeSDK)
    │
    ├──→ FileSpanExporter       → ~/.kanade/traces/<date>/spans.jsonl
    ├──→ FileLogExporter        → ~/.kanade/logs/<date>/kanade.jsonl
    ├──→ OTLPTraceExporter      → Braintrust / 自建 Collector（配置驱动）
    └──→ ConsoleLogExporter     → stdout（开发环境）
```

**应用代码只用标准 OTel API**，不 import 任何 vendor 包。Exporter 按配置加载，想接 Braintrust 改环境变量即可。

## Files to add

### `setup.ts`

`setupTracing(config)` 初始化 OTel SDK：

- `TracerProvider` + `LoggerProvider` + `MeterProvider`
- 按 config 注册 exporter（file / otlp_http / console）
- 返回 `{ tracer, logger, meter, shutdown() }`

### `file-span-exporter.ts`

`FileSpanExporter implements SpanExporter`：

- 序列化为 OTLP-JSON（每行一个 JSON）
- 路径：`<tracesDir>/<YYYY-MM-DD>/<service_name>.jsonl`
- 每日轮转，symlink `current/` 指向当天
- Append-only，fail-soft（写失败打 console.error 并丢弃）

### `file-log-exporter.ts`

`FileLogExporter implements LogRecordExporter`：

- 路径：`<logsDir>/<YYYY-MM-DD>/<service_name>.jsonl`
- 格式同上，OTLP LogRecord JSON
- 自动携带 traceId/spanId（OTel SDK 从 context 注入）
- 每日轮转 + 过期清理

### `logger.ts`

结构化 Logger 封装，简化 OTel Logs API 调用：

```typescript
export class Logger {
  constructor(
    private otelLogger: logs.Logger,
    private defaultAttrs: Record<string, string> = {},
  ) {}

  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, error?: Error, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;

  /** 返回带 task 上下文的 child logger */
  forTask(taskId: string): Logger;

  /** 返回带 component 上下文的 child logger */
  forComponent(component: string): Logger;
}
```

### `attributes.ts`

常量定义，避免魔法字符串散落代码：

```typescript
// GenAI (OTel semantic conventions)
export const GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
export const GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
export const GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
export const GEN_AI_USAGE_CACHE_READ = 'gen_ai.usage.cache_read.input_tokens';
export const GEN_AI_USAGE_CACHE_CREATION = 'gen_ai.usage.cache_creation.input_tokens';
export const GEN_AI_RESPONSE_FINISH_REASONS = 'gen_ai.response.finish_reasons';
export const GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';

// kanade workflow
export const TASK_ID = 'kanade.task.id';
export const TASK_SOURCE = 'kanade.task.source';
export const TASK_STATUS = 'kanade.task.status';
export const WORKFLOW_NAME = 'kanade.workflow.name';
export const AGENT_LABEL = 'kanade.agent.label';
export const AGENT_ROLE = 'kanade.agent.role';
export const PHASE_NAME = 'kanade.workflow.phase';
export const ISOLATION_MODE = 'kanade.isolation.mode';
export const ISOLATION_BRANCH = 'kanade.isolation.branch';
export const HUMAN_REQUEST_ID = 'kanade.human.request_id';

// kanade metrics
export const TASK_DURATION = 'kanade.task.duration';
export const TASK_STATUS_COUNT = 'kanade.task.status.count';
export const AGENT_CALL_COUNT = 'kanade.agent.call_count';
export const JOURNAL_HIT_RATE = 'kanade.journal.hit_rate';
export const WORKTREE_ACTIVE = 'kanade.worktree.active';
```

### `metrics.ts`

预定义指标：

```typescript
// 标准 GenAI 指标（OTel semconv）
gen_ai.client.token.usage          // histogram, unit: token
gen_ai.client.operation.duration   // histogram, unit: s

// kanade 业务指标
kanade.task.duration               // histogram, unit: s, 按 source/status 分
kanade.task.status.count           // counter, 按 status 分
kanade.agent.call_count            // histogram, 每 task 的 agent 调用数
kanade.journal.hit_rate            // gauge, 0-1
kanade.worktree.active             // gauge, 当前活跃数
```

### `index.ts`

Re-exports + `setupTracing()` 入口。

## Log 标准字段

每条日志必须携带的字段（OTel LogRecord 属性）：

```
字段                  来源                    说明
────                  ────                    ────
traceId               OTel SDK 自动注入        关联到 trace
spanId                OTel SDK 自动注入        关联到 span
severityNumber        logger 方法决定          INFO=9, WARN=13, ERROR=17, DEBUG=5
severityText          logger 方法决定          "INFO" / "WARN" / "ERROR" / "DEBUG"
timestamp             OTel SDK 自动            ISO 8601
body                  message 参数             日志正文

// 业务字段（通过 defaultAttrs 或 fields 传入）
kanade.task.id        forTask() 设置          任务 ID
kanade.component      forComponent() 设置     server / runtime / agent / isolation / human
```

用 traceId 还原日志：

```bash
# 本地文件：grep traceId
grep '"traceId":"abc123"' ~/.kanade/logs/2026-05-30/*.jsonl

# 或者用 jq
cat ~/.kanade/logs/2026-05-30/kanade.jsonl | jq 'select(.traceId == "abc123")'
```

## 采样策略

三个维度独立控制：

### 1. Trace 采样（span 级别）

```yaml
tracing:
  sampling:
    # 总体采样率（0-1），1 = 全量
    rate: 1.0

    # 以下 span 类型始终采样（不管 rate）
    always_sample:
      - workflow.task       # 每个 task 的根 span
      - workflow.author     # generated 脚本生成
      - human.request       # 人工请求（量少、重要）

    # 以下 span 类型按 rate 采样
    default_sample:
      - workflow.agent      # agent 调用（量大）
      - llm.chat            # LLM 调用（量大）
      - tool.execute        # tool 调用
```

实现：自定义 `Sampler`，对 `workflow.task` 和 `human.request` 返回 `RECORD_AND_SAMPLED`，其他按 rate 随机。

### 2. Log 采样

```yaml
tracing:
  log_sampling:
    # ERROR/WARN 全量，INFO 按 rate
    error_rate: 1.0
    warn_rate: 1.0
    info_rate: 0.1    # 高频 INFO 只留 10%
    debug_rate: 0.0   # 生产关 debug
```

实现：自定义 `LogRecordProcessor`，在 `onEmit` 里按 severity 和 rate 决定是否导出。

### 3. Content 采样（prompt/completion 内容）

```yaml
tracing:
  # prompt 和 completion 内容默认不记录（大 + 可能含敏感信息）
  capture_content: false

  # 开启后只在以下场景记录
  content_sample:
    rate: 0.1           # 10% 的 LLM 调用记录完整 prompt/response
    always_on_error: true  # 失败的调用全量记录
```

实现：在 `workflow-agent.ts` 的 agent span 上，按配置决定是否设 `gen_ai.input.messages` / `gen_ai.output.messages` 属性。

## OTLP Exporter 配置

```yaml
tracing:
  exporters:
    - type: file
      dir: ~/.kanade/traces         # span 文件
      log_dir: ~/.kanade/logs       # log 文件
      rotate: daily

    - type: otlp_http               # Braintrust / 自建 Collector
      endpoint: ${OTEL_EXPORTER_OTLP_ENDPOINT:-}
      headers: ${OTEL_EXPORTER_OTLP_HEADERS:-}
      # endpoint 为空时跳过（不发）
```

接 Braintrust：

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=https://api.braintrust.dev/otel/v1/traces
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer sk-xxx, x-bt-parent=project_name:kanade"
```

零代码改动，改环境变量即可。

## 文件过期清理

```yaml
cleanup:
  log_retention_days: 30       # 日志保留 30 天
  trace_retention_days: 90     # trace 保留 90 天
```

CleanupScheduler 统一清理 `~/.kanade/logs/` 和 `~/.kanade/traces/` 下超过保留天数的目录。

## Span 层级

```
trace: task_T-2042                          kanade.task.id=T-2042
└── span: workflow.task                     kanade.task.source=saved
    ├── span: workflow.author               (generated 模式才有)
    ├── span: workflow.phase                kanade.workflow.phase=设计
    │   ├── span: workflow.agent            kanade.agent.label=dev, role=developer
    │   │   └── span: llm.chat              gen_ai.request.model=claude-sonnet
    │   │                                   gen_ai.usage.input_tokens=1500
    │   └── span: workflow.agent            kanade.agent.label=reviewer
    ├── span: isolation.prepare             kanade.isolation.mode=worktree
    ├── span: human.request                 kanade.human.request_id=req-1
    └── span: isolation.finalize            kanade.isolation.branch=kanade/T-2042/dev
```

## Log 与 Trace 关联示例

一次 task 执行产生的日志（通过 traceId 串联）：

```jsonl
{"timestamp":"2026-05-30T14:30:00Z","severityText":"INFO","body":"task created","traceId":"abc","spanId":"001","attributes":{"kanade.task.id":"T-2042","kanade.task.source":"saved"}}
{"timestamp":"2026-05-30T14:30:00Z","severityText":"INFO","body":"task running","traceId":"abc","spanId":"001","attributes":{"kanade.task.id":"T-2042"}}
{"timestamp":"2026-05-30T14:30:01Z","severityText":"INFO","body":"agent started","traceId":"abc","spanId":"002","attributes":{"kanade.task.id":"T-2042","kanade.agent.label":"dev","kanade.agent.role":"developer"}}
{"timestamp":"2026-05-30T14:30:05Z","severityText":"INFO","body":"agent completed","traceId":"abc","spanId":"002","attributes":{"kanade.task.id":"T-2042","kanade.agent.label":"dev"}}
{"timestamp":"2026-05-30T14:30:05Z","severityText":"INFO","body":"task finished","traceId":"abc","spanId":"001","attributes":{"kanade.task.id":"T-2042","kanade.task.status":"finished"}}
```

用 `traceId=abc` 即可还原整条执行链路。

## 环境变量

```
OTEL_EXPORTER_OTLP_ENDPOINT    OTLP 后端地址（空则不发）
OTEL_EXPORTER_OTLP_HEADERS     OTLP 请求头（含 auth）
KANADE_TRACE_SAMPLING_RATE     trace 采样率覆盖（0-1）
KANADE_LOG_SAMPLING_RATE       log 采样率覆盖（0-1）
KANADE_CAPTURE_CONTENT         是否记录 prompt/completion（true/false）
```

## 约束

- 应用代码只用 `@opentelemetry/api`（types），不 import `@opentelemetry/sdk-*`（实现在 setup.ts 里）
- 不 import 任何 vendor 包（braintrust/langfuse/sentry）
- GenAI 属性名遵循 OTel semantic conventions（Development 状态，需关注升级）
- Content capture 默认关闭，开启需显式配置
- 所有 exporter fail-soft：写失败不阻塞业务
