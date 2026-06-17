# Local Agent QA Hardening Brief

Date: 2026-06-17

## Status

Hardening implementation and live validation are complete for the local QA
platform. The focused parallel pilot ran against the isolated stack and
produced a classified report with no pending or blocked playbooks.

Focused pilot:

```text
.local/qa-runs/hardening-focused-pilot/report.md
```

Summary:

```text
pass=4
fail=2
blocked=0
needs-human-review=0
pending=0
```

## Implemented

- Added `scripts/qa/env.sh` for one-command QA environment lifecycle:
  `render`, `up`, `status`, `reset`, `down`.
- `scripts/qa/env.sh up` now prepares local fixture assets before app services
  start, so app containers see the per-worktree fixture data root.
- Added local fixture asset generation with `scripts/qa/prepare-fixtures.sh`.
- Added Auth/Mailpit recovery readiness check with
  `scripts/qa/check-auth-mailpit.sh`; the checker records pre-existing Mailpit
  message IDs and accepts string or object address shapes from the Mailpit API.
- Expanded `qa-full` seed intent with deterministic PRIWA, labels/corrections,
  and publication fixture rows.
- Added conflict-aware worker scheduling in `scripts/qa/run-agent-qa.sh`.
- Added worker data locks to manifests/prompts.
- Added finding category support to `scripts/qa/report.sh`.
- Added Browser Use CLI probe and evidence.
- Added Playwright upload fallback helper.
- Updated `docs/qa/plan-vs-result-brief.md` with this hardening result.
- `scripts/qa/env.sh` keeps Vite alive in a per-worktree tmux session when
  available, which avoids detached-dev-server exits caused by closed stdin.
- `scripts/qa/env.sh up` connects the app Mailpit container to the Supabase
  network with the hostname expected by the older local GoTrue container.

## Browser Use CLI Result

Browser Use CLI is viable as an optional local worker tool:

- available through `uvx --from browser-use`,
- exposes named sessions,
- passed `doctor` outside the sandbox,
- maintained multiple named local sessions,
- passed the automated `scripts/qa/browser-use-cli-probe.sh --exercise-upload`
  probe,
- successfully attached
  `frontend/test/fixtures/geotiff/upload-validation/rgb-real-crop.tif` to a
  local HTTP probe page via the CLI `upload` command,
- opened the real isolated frontend at `http://127.0.0.1:57073/` in a named
  session and evaluated `document.title` as `deadtrees.earth`.

Evidence:

```text
docs/qa/browser-use-cli-evidence.md
```

## Validation Completed

```bash
bash -n scripts/dev/isolated-supabase.sh scripts/qa/*.sh frontend/scripts/run-vite-profile.sh
scripts/qa/lint-playbooks.sh
scripts/qa/env.sh render
scripts/qa/prepare-fixtures.sh qa-full
scripts/qa/run-agent-qa.sh --profile qa-full --parallel 4 --dry-run --run-dir .local/qa-runs/hardening-dry-run
scripts/qa/report.sh .local/qa-runs/hardening-dry-run
scripts/qa/browser-use-cli-probe.sh .local/qa-runs/browser-use-cli-probe --exercise-upload
scripts/qa/env.sh up
scripts/qa/env.sh reset
scripts/qa/check-auth-mailpit.sh
scripts/qa/playwright-upload-probe.sh .local/qa-runs/playwright-upload-probe
scripts/qa/run-agent-qa.sh \
  --profile qa-full \
  --parallel 3 \
  --playbook auth-shell \
  --playbook contributor-upload-process \
  --playbook public-archive-detail-download \
  --playbook priwa-field-workflow \
  --playbook labels-corrections-map \
  --playbook negative-empty-error-states \
  --run-dir .local/qa-runs/hardening-focused-pilot
scripts/qa/report.sh .local/qa-runs/hardening-focused-pilot
npm --prefix frontend run lint
scripts/lint-ast-grep.sh
git diff --check
```

The dry run confirmed all `dataset:91001` mutating playbooks are assigned to
one worker, avoiding same-row parallel mutation.

The generated isolated env now points app containers at a per-worktree ignored
data root:

```text
.local/qa-data
```

This avoids writing QA fixture assets through the repository's shared `data`
symlink.

## Focused Pilot Result

The focused parallel pilot found four passing playbooks and two product bugs:

- `auth-shell`: pass
- `contributor-upload-process`: pass
- `negative-empty-error-states`: pass
- `priwa-field-workflow`: pass
- `public-archive-detail-download`: fail, `product-bug`
- `labels-corrections-map`: fail, `product-bug`

The two failures are real product/fixture-surface findings, not QA platform
blockers:

- The public archive did not expose seeded public dataset `91001`; direct detail
  route worked, but anonymous download was disabled and the seeded COG produced
  an `Invalid byte order value` console error.
- The contributor corrections route for dataset `91001` did not mount a usable
  map/editor; the fixed header intercepted the `Start Editing Deadwood cover`
  click, while the auditor label route rendered but still showed the seeded COG
  byte-order error.

## Next Action

Turn the two product bugs into focused implementation work:

- Fix archive public dataset visibility and provide a valid minimal QA COG.
- Fix the correction editor header/map initialization path and add durable local
  E2E coverage for contributor correction start plus auditor review.
