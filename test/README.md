# Tests

Kanade uses Vitest for unit, integration, mock E2E, CLI, and eval-scoring tests.

## Run

```bash
npm test                         # full suite
npm run lint
npm run typecheck
npm run smoke:pi-kanade           # Pi cockpit component smoke harness

# Focused runs
npx vitest run src/workflow-engine/
npx vitest run src/server/
npx vitest run test/e2e-mock/
npx vitest run test/e2e-mock/cli.test.ts
npx vitest run eval/scorer.test.ts
```

## Layout

```text
src/**/*.test.ts        Unit and integration tests next to source modules
test/e2e-mock/         Full runtime E2E tests with mocked LLM sessions
eval/*.test.ts         Evaluation scorer/reporter tests
scripts/smoke-*.ts     Smoke harnesses for generated workflows and Pi UI
```

## Layers

### Unit tests

Small module tests for config loading, journals, human gates, role loading, tracing, prompt guidelines, and project-profile detection.

### Integration tests

Cross-module tests for:

- workflow parsing and sandbox execution;
- agent wrapper behavior, role/tool filtering, journal cache, and isolation;
- HTTP routes and task lifecycle;
- workflow-store CRUD;
- git worktree creation, reuse, cleanup, merge, and recovery.

### Mock E2E tests

`test/e2e-mock/` runs the real server/task-manager/runtime stack while replacing only the LLM session factory with `MockSession`.

```text
script text
  → parseWorkflowScript
  → vm sandbox
  → agent() / parallel() / pipeline() / phase() / request_human()
  → WorkflowAgent.run()
  → MockSession.prompt()
  → journal / task state / events / snapshots
```

This validates the runtime contract without requiring network access or paid model calls.

### CLI tests

`test/e2e-mock/cli.test.ts` starts isolated Kanade instances and exercises the public CLI against real HTTP endpoints.

### Pi cockpit smoke tests

`npm run smoke:pi-kanade` loads `.pi/extensions/kanade` without a live terminal, fakes Kanade API responses, renders components, and exercises interactions such as search, action menus, settings edits, recovery cleanup confirmation, usage/review tabs, and agent detail scrolling.

## CI

GitHub Actions runs on push/PR to `main` and `develop`:

```text
npm ci
npm run lint
npm run typecheck
npm test -- --exclude '.tmp/**'
```
