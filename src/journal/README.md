# journal

Per-task SQLite journal for agent call result caching.

## What goes here

See `docs/06-workflow-engine.md` §journal.

Files to add:

- `journal.ts` — `Journal` class:
  - `lookup(cacheKey)` → `{ result, tokens } | null`
  - `write(cacheKey, { result, tokens })`
  - `lookupHuman(cacheKey)` / `writeHuman(cacheKey, response)`
  - Stored at `paths.runsDir/<task_id>/journal.db` (per-task DB, not shared)
- `cache-key.ts` — `hashCall({ prompt, role, schema, model, instructions, cwd })` — stable SHA-256 over JSON-serialized payload, sorted keys. Excludes `label` and `phase` (debug-only).
- `index.ts` — Re-exports.

## Schema

```sql
CREATE TABLE journal (
  cache_key TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  tokens INTEGER,
  created_at INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE journal_human (
  cache_key TEXT PRIMARY KEY,
  response TEXT NOT NULL,
  resolved_at INTEGER NOT NULL
);
```

## Constraints

- One DB per task. Created lazily on first `agent()` call.
- `hit_count` increments on each lookup hit (for trace/debug).
- DB closing happens on task finalization.
