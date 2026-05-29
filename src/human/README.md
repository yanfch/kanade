# human

NEEDS_HUMAN gate — pause workflow until user responds.

## What goes here

See `docs/02-orchestrator.md` §人工确认机制 and `docs/06-workflow-engine.md` §request_human.

Files to add:

- `human-gate.ts` — `HumanGate` class:
  - `wait(requestId, signal)` → `Promise<HumanResponse>` — polls StateStore.getNeedsHuman until status='resolved'
  - `resolve(requestId, response)` — called from server REST handler, marks resolved + wakes pollers
  - In-memory waker map (Map<requestId, resolve fn>) + DB poll fallback for crash recovery
- `types.ts` — `HumanRequest` / `HumanResponse` interfaces (match docs).
- `index.ts` — Re-exports.

## Constraints

- Polling interval: 1s (cheap, simple, works after process restart).
- Support `AbortSignal` so task abort releases waiters.
- Journal cache integration: caller checks journal before calling `wait()` so reruns skip resolved requests.
- Optionally fire VoiceBar `/v1/notify` on insert (configurable in `config.yml`).
