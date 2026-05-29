# tracing

OpenTelemetry setup with FileSpanExporter (MVP).

## What goes here

See `docs/04-tracing.md` (full design including W3C trace context propagation, OTel GenAI conventions, attribute names).

Files to add:

- `setup.ts` — `setupTracing(config)` builds a `NodeTracerProvider` (or equivalent), registers exporters, returns the global tracer.
- `file-exporter.ts` — `FileSpanExporter implements SpanExporter`:
  - Serialize spans to OTLP-JSON form (one JSON per line)
  - Write to `<tracesDir>/<YYYY-MM-DD>/<service_name>.jsonl`
  - Daily rotation; current-day symlink as `current/<service_name>.jsonl`
  - Append-only, fail-soft (log + drop on disk error)
- `attributes.ts` — Attribute key constants (gen_ai.*, stt.*, tts.*, workflow.*, agent.*) so different layers stay consistent.
- `index.ts` — Re-exports.

## Constraints

- Default exporter type: `file`. `otlp_http` is supported but optional (V2).
- Multi-exporter: config can list multiple exporters; all run in parallel.
- W3C `traceparent` propagation must be enabled (Hono middleware extracts incoming, fetch wrapper injects outgoing).
- Always include `gen_ai.usage.cache_read_input_tokens` / `cache_creation_input_tokens` on LLM spans (required for cache observability — see `docs/02-orchestrator.md` §Prompt Caching 策略).
