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

## Hardening Update

Date: 2026-06-17

The recommended next slice has been implemented as a local QA hardening pass.

Delivered:

- `scripts/qa/env.sh` now provides a single lifecycle entry point for
  rendering, starting, checking, resetting, and stopping the isolated QA stack.
- App containers now use an ignored per-worktree data root via
  `LOCAL_DATA_ROOT=.local/qa-data`, avoiding writes through the shared `data`
  symlink.
- `scripts/qa/prepare-fixtures.sh` creates deterministic local fixture files
  for archive, COG, and thumbnail paths used by seeded QA datasets.
- `qa-full` seed data now includes PRIWA rows, label/correction rows, and a
  publication fixture, with `scripts/qa/check-fixtures.sql` covering the new
  domain rows.
- `scripts/qa/run-agent-qa.sh` now assigns resource locks to mutating playbooks
  so playbooks touching the same dataset are co-located on one worker.
- Worker prompts now document Browser Use CLI for isolated sessions/upload
  flows and Playwright as the deterministic upload fallback.
- `scripts/qa/report.sh` now aggregates finding categories.
- Browser Use CLI was tested through `uvx --from browser-use` and passed a
  local named-session plus file-upload probe.

Validation completed:

```bash
bash -n scripts/dev/isolated-supabase.sh scripts/qa/*.sh frontend/scripts/run-vite-profile.sh
scripts/qa/lint-playbooks.sh
scripts/qa/env.sh render
scripts/qa/prepare-fixtures.sh qa-full
scripts/qa/run-agent-qa.sh --profile qa-full --parallel 4 --dry-run --run-dir .local/qa-runs/hardening-dry-run
scripts/qa/report.sh .local/qa-runs/hardening-dry-run
scripts/qa/browser-use-cli-probe.sh .local/qa-runs/browser-use-cli-probe --exercise-upload
npm --prefix frontend run lint
scripts/lint-ast-grep.sh
git diff --check
```

Live validation completed after Docker was restarted:

```bash
scripts/qa/env.sh up
scripts/qa/env.sh reset
scripts/qa/check-auth-mailpit.sh
scripts/qa/playwright-upload-probe.sh .local/qa-runs/playwright-upload-probe
scripts/qa/run-agent-qa.sh --profile qa-full --parallel 3 \
  --playbook auth-shell \
  --playbook contributor-upload-process \
  --playbook public-archive-detail-download \
  --playbook priwa-field-workflow \
  --playbook labels-corrections-map \
  --playbook negative-empty-error-states \
  --run-dir .local/qa-runs/hardening-focused-pilot
scripts/qa/report.sh .local/qa-runs/hardening-focused-pilot
```

Focused pilot result:

```text
.local/qa-runs/hardening-focused-pilot/report.md
pass=4
fail=2
blocked=0
needs-human-review=0
pending=0
```

Remaining findings are product bugs, not QA platform blockers:

- `public-archive-detail-download`: seeded dataset `91001` did not appear in
  the public archive list; direct detail route worked, but anonymous download
  was disabled and the seeded COG produced `Invalid byte order value`.
- `labels-corrections-map`: contributor correction route did not mount a usable
  map/editor and the fixed header intercepted `Start Editing Deadwood cover`;
  auditor label route rendered but still hit the seeded COG byte-order error.

Detailed hardening notes are in `docs/qa/local-agent-qa-hardening-brief.md`.
