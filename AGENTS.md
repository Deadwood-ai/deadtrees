# DeadTrees Agent Instructions

Codex is the primary coding agent for this repository. Start here, then open
the linked docs that match the task.

## Source Of Truth

- Repo-wide agent guide: `docs/agents/README.md`
- Core engineering rules: `docs/agents/rules.md`
- Project structure guidance: `docs/agents/project-structure.md`
- Environment and access model: `docs/agents/environment-and-access.md`
- Platform status playbook: `docs/playbooks/platform-status-check.md`
- Frontend-specific agent rules: `frontend/AGENTS.md`

## Safety

- Do not commit, push, open a PR, or mutate production unless the user explicitly asks.
- Do not print or copy credentials into chat, tracked docs, examples, or `frontend/.env*`.
- Keep large searches, logs, tests, and diagnostics capped and summarized. Prefer targeted
  `rg`, `jq`, `head`, `tail`, and explicit output limits.
- Production code changes should land through PR review and the merge-to-main deploy path.
  Manual production intervention requires explicit user approval.
- For database work, use the configured Supabase/Postgres MCP or documented local database
  path. Treat production database writes as off-limits unless the user explicitly authorizes
  a specific write.

## Git And PRs

- Do not create draft PRs for this workspace. Open normal PRs when asked.
- PR titles must pass `.github/workflows/pr-title-check.yml`.
- Use Conventional Commit format: `type(scope): short summary`.
- Allowed types: `feat`, `fix`, `docs`, `chore`, `refactor`, `perf`, `test`, `build`, `ci`, `revert`.
- Good example: `fix(frontend): align tree and deadwood cover labels`.
- PR bodies should be concise and changelog-friendly: what changed, why, who it helps,
  validation done, and any user-visible risk.

## Local-Only Access

Credentials and machine-specific access notes are intentionally not tracked.

- Human-readable local notes: `docs/ops/local-access.md` if present
- Codex-local notes and MCP credentials: `.codex/local-access.md` and `.codex/config.toml`
- App/runtime env: `.env`
- Browser-facing frontend profiles: `frontend/.env.dev.local`, `frontend/.env.prod.local`

If a local-only file is missing, use `docs/agents/environment-and-access.md` to understand
where it belongs. Ask the user for credentials instead of inventing or moving secrets.
