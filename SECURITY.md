# Security policy

Kanade is a local automation runtime. Workflow scripts, agents, and optional Pi extensions run with local user permissions and can affect files in configured worktrees.

## Supported versions

Kanade is currently pre-1.0. Please report security issues against the latest `main` branch unless release branches are introduced later.

## Reporting a vulnerability

Please do not open a public issue for sensitive vulnerabilities.

For now, contact the maintainer directly or use GitHub private vulnerability reporting if it is enabled on the repository.

Include:

- affected commit/version;
- reproduction steps;
- impact and affected files/components;
- whether the issue requires a malicious workflow, malicious repository, or normal user action.

## Safety model

- Only run workflows and extensions you trust.
- Inspect generated workflows before saving or sharing them.
- Review diffs, checks, and human decisions before merging task worktrees.
- Treat `kanade reject`, `kanade merge`, and `kanade abort` as explicit user-confirmed actions.
- Keep credentials out of repository files; use local config and provider auth files.
