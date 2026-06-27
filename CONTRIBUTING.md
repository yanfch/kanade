# Contributing

Thanks for helping improve Kanade.

## Development setup

```bash
git clone https://github.com/yanfch/kanade.git
cd kanade
npm install
npm run typecheck
npm test
```

## Before opening a PR

Run the same checks used by CI:

```bash
npm run lint
npm run typecheck
npm test
npm run smoke:pi-kanade
```

For changes that affect generated workflows or live acceptance behavior, also consider the relevant smoke/eval command:

```bash
npm run eval
npm run smoke:generated-workflow
```

## Coding guidelines

- Keep public APIs and CLI output intentional; update docs when behavior changes.
- Preserve failed/aborted worktrees by default unless the user explicitly asks for cleanup.
- Dangerous lifecycle actions such as merge, reject cleanup, and abort should require explicit user intent.
- Prefer small, focused PRs with tests.
- Put user-facing documentation in `docs/`; avoid committing internal scratch notes.

## Tests

- Unit/integration tests live next to source files in `src/**/*.test.ts`.
- Mock E2E tests live in `test/e2e-mock/`.
- Pi cockpit smoke coverage is in `scripts/smoke-pi-kanade.ts`.

## License

By contributing, you agree that your contribution is licensed under the MIT license.
