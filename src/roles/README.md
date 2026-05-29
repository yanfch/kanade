# roles

Role loader, prompt builder, tool-whitelist filtering.

## What goes here

See `docs/02-orchestrator.md` (核心概念 → 角色) and `docs/06-workflow-engine.md` (agent.ts internal flow).

Files to add:

- `loader.ts` — `loadRole(name)` reads `~/.kanade/roles/<name>/`:
  - `role.md` → system prompt body
  - `tools.json` → `{ allow: string[], extensions?: string[] }`
  - `default-schema.json` → optional default schema
  - `default-model.txt` → optional model override
  - `extensions/*.ts` → role-specific extensions
- `prompt-builder.ts` — `buildSubagentPrompt(opts)` assembles role identity + phase + label + task + structured-output contract. See `06-workflow-engine.md` §3.
- `index.ts` — Re-exports + `RoleConfig` type.

## Conventions

- Role names are kebab-case directory names: `developer`, `code-reviewer`.
- Role definitions are version-controlled (live in dotfiles repo).
- `tools.allow` is a whitelist filter applied against pi's `createCodingTools(cwd)` output.
- Caller can override `schema` / `model` per call; role provides defaults only.
