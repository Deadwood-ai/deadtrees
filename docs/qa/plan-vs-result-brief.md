# Local Agent QA Plan vs Result Brief

Date: 2026-06-16

## Result

The first local agent-driven QA platform slice is implemented and validated.

Delivered:

- isolated per-worktree Supabase/app environment support,
- deterministic local QA users and base datasets,
- 12 agent-followable playbooks,
- playbook metadata linting,
- local QA runner with worker prompt generation,
- result aggregation and report generation,
- browser tool decision docs,
- first real four-worker Codex parallel QA run.

Primary run:

```text
.local/qa-runs/parallel-pilot-001/report.md
```

Summary:

```text
pass=3
fail=2
blocked=2
needs-human-review=5
pending=0
```

## What Matched The Plan

- Full local isolation is viable with generated Supabase state, generated port
  bands, generated Compose env, and ignored `.local/` runtime files.
- The light Supabase profile is sufficient for the default QA lane.
- The runner can seed, check readiness, split 12 playbooks over 4 workers, and
  aggregate worker result files.
- Built-in Browser is a good default for route, locator, console, and local API
  evidence.
- Parallel agents can work from generated prompts without hidden context.

## What Changed

- The runner remains a prompt/package generator instead of launching Codex
  agents directly. That is intentional for portability; direct launch can be an
  optional future mode.
- The first browser comparison is Browser-first. Chrome was not exposed as a
  controllable backend in this session, and Computer Use remains a fallback.
- Some fixture packs are documented and partially represented by `qa-full`, but
  `qa-priwa`, `qa-labels`, and `qa-publication` need deeper rows before their
  playbooks become strict pass/fail checks.

## Findings From The Pilot

- `auth-shell` failed because password reset did not deliver recovery mail to
  local Mailpit.
- `negative-empty-error-states` failed because dataset `91004` still exposes
  complete-dataset download UI despite representing an error/incomplete state.
- `public-archive-detail-download` needs review because the seeded archive file
  is missing from local storage.
- `auditor-queue-triage` needs review because the processing tab count did not
  include fixture `91004`.
- `labels-corrections-map` and `priwa-field-workflow` need deeper fixture data.
- `contributor-upload-process` was blocked by Browser file-upload attachment,
  which likely needs a Playwright-backed fallback.

## Recommended Next Slice

1. Fix the isolated Supabase Mailpit/recovery-email configuration.
2. Add local storage files for seeded archive/download fixtures.
3. Expand `qa-priwa`, `qa-labels`, and `qa-publication` fixture rows.
4. Add a file-upload execution fallback for the contributor upload playbook.
5. Re-run only the failed, blocked, and review playbooks.
6. Convert confirmed product behavior issues into normal implementation
   tickets or PR work.
