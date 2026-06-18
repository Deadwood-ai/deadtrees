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

## Local Test Environment

- For exploration, code reading, docs edits, static analysis, and narrow unit or
  lint checks, do not start the full local dev stack unless the task needs it.
- For full test-suite work, API tests against Supabase, local E2E, browser
  validation, QA-agent runs, Auth/Mailpit flows, upload/download flows, or any
  work that needs the app running, first bootstrap and validate the isolated
  per-worktree environment:

```bash
bash scripts/setup-worktree.sh --skip-assets
scripts/qa/env.sh up
scripts/qa/env.sh reset
scripts/qa/validate-isolated-env.sh
```

- Use the generated `.local/supabase/current.env` endpoints for frontend, API,
  Supabase, Mailpit, Docker Compose, Playwright, and QA agents. Do not use the
  default shared Supabase ports for full QA/test work.
- See `docs/agents/environment-and-access.md` for the routing table, manual
  `source` command, and teardown guidance.

## Review guidelines

- Prioritize concrete P0/P1 risks: correctness bugs, security regressions, data loss, broken authorization, production deployment hazards, and missing validation for high-risk changes.
- Treat readability, maintainability, and testability as review concerns when they create concrete future risk: duplicated workflow logic, unclear ownership, hidden side effects, brittle coupling, hard-to-test flows, oversized unstructured functions, or confusing domain names.
- For architecture-sensitive changes, check whether the PR spreads behavior across callers, weakens locality, or introduces shallow pass-through modules that make future changes harder to verify.
- For changed interfaces, check that callers do not need to know hidden ordering, config, error modes, permission rules, storage details, or deployment assumptions that should stay behind one module interface.
- For database, storage, deployment, or production-connected changes, require evidence of repo-approved validation and flag unsafe production assumptions.
- For security, flag changes that weaken auth, authorization, RLS/policies, tenancy isolation, signed URL handling, upload validation, secret handling, logging of sensitive data, CORS/cookie/session controls, or privilege boundaries.
- Treat credentials, bearer tokens, database URLs, private keys, raw production access notes, and PII in tracked files or logs as P1.
- Do not flag subjective style preferences, formatting, or broad cleanup ideas unless they affect correctness, security, maintainability, or testability in the changed code.

## Git And PRs

- Before creating a worktree/branch for implementation, QA, or broad tests,
  fetch `origin` and base it on current `origin/main` unless told otherwise.
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
