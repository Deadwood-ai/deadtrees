# Codex Agent Guide

This directory is the tracked source of truth for agent-facing rules. Codex should
use these files directly; editor-specific rule folders are intentionally retired.

## How To Navigate

1. Read the root `AGENTS.md` first.
2. Read `docs/agents/rules.md` for project rules, architecture, testing, and gotchas.
3. Read `docs/agents/project-structure.md` before adding files or moving code.
4. Read `docs/agents/environment-and-access.md` before touching env files, MCP config,
   remote hosts, or credentials.
5. For frontend work, also read `frontend/AGENTS.md`.
6. For recurring operational checks, use `docs/playbooks/platform-status-check.md`.
7. For dataset failures, stuck processing, or upload-triggered failures, use
   `docs/playbooks/dataset-debugging.md`.
8. For diagrams, use `docs/playbooks/technical-diagrams.md`.
9. For `/reflect-and-learn` or end-of-session retrospectives, use
   `docs/playbooks/reflect-and-learn.md`. Use `docs/playbooks/reflect-context.md`
   when the focus is only rules/docs context cleanup.
10. For release or deploy questions, use `docs/playbooks/create-release.md`,
   `docs/playbooks/processor-deploy.md`, and local-only `docs/ops/*` files when present.

## Tracked Versus Local

Tracked files should explain behavior, workflow, file names, and secret boundaries.
They must not contain real passwords, API tokens, private keys, bearer tokens, or
machine-specific private host credentials.

Local-only files may contain real access details and are ignored:

- `.env`
- `.codex/config.toml`
- `.codex/local-access.md`
- `docs/ops/*`
- `frontend/.env.*.local`
- `.local/`

When a task needs local or production access, inspect those local files without
printing secret values back to the user.

## Migration Notes

The old editor-specific rules mixed durable project knowledge with tool-specific
syntax, stale MCP names, and local access assumptions. Durable guidance now lives
here and in root/frontend `AGENTS.md`. If you find references to retired rule
paths, old MCP names, or old repository names, treat them as stale unless current
code proves otherwise.
