# Local Agent QA Hardening Plan

## Goal Prompt

Use this prompt as the `/goal` objective for execution:

```text
Implement the approved hardening plan in docs/qa/local-agent-qa-hardening-plan.md.

Turn the first DeadTrees local agent QA platform into a more reliable parallel
worktree QA system. Fix the system gaps found in the first pilot: one-command
isolated environment lifecycle, fixture assets and deeper fixture packs,
per-worker data isolation, browser/session isolation, file-upload fallback,
Mailpit/Auth recovery readiness, finding classification, and a Browser Use CLI
experiment for browser isolation and upload flows. Keep all production data and
credentials untouched. Preserve generated run state under ignored `.local/`
paths. Run the validation plan and produce an updated plan-vs-result brief.
```

## Background

The first local QA platform slice proved that the approach works:

- isolated Supabase/app envs are viable,
- 12 playbooks can be split over 4 agents,
- generated prompts are enough for parallel Codex execution,
- the built-in Browser gives useful route/locator/console evidence.

The first four-agent run also exposed system gaps:

- environment lifecycle still requires several manual commands,
- fixture packs seed DB rows but not all required local files and domain rows,
- mutating workers share the same dataset IDs,
- Browser sessions can leak auth state between workers,
- Browser file upload could not attach a GeoTIFF,
- Auth health passed while password reset did not reach Mailpit,
- reports do not classify whether findings are fixture gaps, product bugs, or
  tool limitations.

## Goal

Make the local QA system reliable enough that a future operator can run:

```bash
scripts/qa/env.sh up
scripts/qa/run-agent-qa.sh --profile qa-full --parallel 4
```

and receive a classified, reproducible report that is safe to hand to a
developer.

## Non-Goals

- Do not fix unrelated product UX bugs unless they block the QA system itself.
- Do not add production credentials or production data.
- Do not make Browser Use CLI a hard dependency unless the experiment proves it
  materially improves isolation or file upload.
- Do not replace existing Playwright tests or repo-native smoke tests.
- Do not open a PR in this phase.

## Assumptions

- Docker and Supabase CLI are available locally.
- Browser Use CLI is not currently installed locally; it may need an optional
  local install or may prove unsuitable.
- The default stable path must continue to work without Browser Use CLI.
- Local QA run artifacts can stay under ignored `.local/qa-runs/`.

## Scope

Affected surfaces:

- `scripts/qa/`
- `scripts/dev/`
- `supabase/seeds/qa/`
- `docs/qa/`
- local fixture files under a tracked QA fixture path if needed
- frontend local config only if needed for QA isolation

## Implementation Plan

### 1. One-Command QA Environment Lifecycle

Add a QA environment wrapper with commands such as:

```bash
scripts/qa/env.sh render
scripts/qa/env.sh up
scripts/qa/env.sh status
scripts/qa/env.sh reset
scripts/qa/env.sh down
```

Responsibilities:

- render/load isolated Supabase env,
- start light Supabase,
- start app services with generated ports,
- write `.local/qa/env-summary.json`,
- verify Supabase/Auth/API/nginx/Mailpit readiness,
- avoid rewriting tracked config,
- stop foreground/background processes it starts.

### 2. Fixture Assets And Deeper Fixture Packs

Extend fixtures beyond DB rows:

- create deterministic local archive/download files for seeded datasets,
- create thumbnail/COG placeholder files or adjust fixture rows to match files
  that exist,
- expand `qa-priwa` rows enough for PRIWA field access,
- expand `qa-labels` rows enough for correction/map playbooks,
- expand `qa-publication` rows or document that the current release catalog is
  static and not fixture-backed,
- update `scripts/qa/check-fixtures.sql` to assert required assets/domain rows.

### 3. Per-Worker Data Isolation

Teach the runner to prepare worker-safe data for mutating playbooks.

Initial acceptable approaches:

- generate per-worker environment metadata and recommend reset before mutating
  retries, or
- add deterministic worker dataset ID ranges, e.g. `91101-91199`,
  `91201-91299`, and assign mutating playbooks to those rows.

Acceptance requires at least one concrete mechanism that prevents two workers
from mutating the same row in the same run.

### 4. Browser/Session Isolation And Browser Use CLI Experiment

Test whether Browser Use CLI can improve on the built-in Browser for:

- per-worker browser/session isolation,
- independent auth state,
- file upload,
- local artifact capture.

Experiment steps:

- detect whether Browser Use CLI is installed,
- if missing, document/install it only in an ignored local tool path or use
  `uvx`/`pipx`/equivalent if available,
- run a tiny local route smoke with an isolated browser profile,
- run one auth/session isolation probe with two independent users,
- run one file-upload probe against the contributor upload UI if feasible.

Outcomes:

- If Browser Use CLI works better, document it as an optional/default worker
  browser mode and update generated prompts.
- If it is unavailable or weaker than expected, document the blocker and keep
  built-in Browser plus Playwright fallback.

### 5. File Upload Fallback

Add a supported path for playbooks that need file upload:

- Browser Use CLI if the experiment succeeds, otherwise
- a Playwright-backed helper script scoped to upload checks.

The fallback must store artifacts under the worker directory and keep evidence
compatible with `scripts/qa/report.sh`.

### 6. Mailpit/Auth Recovery Readiness

Add a readiness check that proves Auth recovery emails reach local Mailpit:

- trigger a local password-recovery email for a QA user,
- assert Mailpit receives at least one matching message,
- classify failure as `qa-platform-gap`.

Patch isolated Supabase config generation if SMTP settings are wrong.

### 7. Finding Classification

Extend result/report conventions with categories:

- `qa-platform-gap`
- `fixture-gap`
- `product-bug`
- `tooling-limitation`
- `needs-design-decision`

Update runner prompts, result template, and report aggregation to show category
counts and per-playbook categories.

### 8. Updated Pilot

Run a focused pilot after hardening:

- `auth-shell`
- `contributor-upload-process`
- `public-archive-detail-download`
- `priwa-field-workflow`
- `labels-corrections-map`
- `negative-empty-error-states`

The pilot should use isolated sessions or the documented fallback.

## Acceptance Criteria

- `scripts/qa/env.sh up/status/down` work for the current worktree.
- `scripts/qa/run-agent-qa.sh --profile qa-full --parallel 4 --dry-run` still
  works.
- Fixture checks include local file/domain-row assertions.
- Password recovery readiness either passes against Mailpit or fails with a
  classified, documented blocker.
- Browser Use CLI experiment is documented with concrete command output and a
  decision.
- File upload has a documented executable fallback.
- Report output includes finding categories.
- A focused hardening pilot produces `report.md` with no `pending` playbooks.
- `docs/qa/plan-vs-result-brief.md` is updated with the hardening result.

## Validation Plan

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

Add live checks when the isolated stack is available:

```bash
scripts/qa/env.sh up
scripts/qa/seed.sh qa-full
scripts/qa/check-auth-mailpit.sh
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
```

## Risks

| Risk | Mitigation |
| --- | --- |
| Browser Use CLI needs network/API keys or is too slow | Make it optional and keep Playwright fallback |
| Fixture rows do not match domain constraints | Add narrow SQL checks before browser execution |
| Per-worker data isolation expands fixture complexity too much | Start with deterministic worker ID bands for mutating playbooks |
| Mailpit behavior depends on Supabase CLI version | Verify via generated local config and concrete recovery email |
| Environment wrapper leaves processes running | Record PIDs under `.local/qa/` and provide `down` cleanup |

## Stop Conditions

Stop and replan if:

- Browser Use CLI requires external credentials or a cloud browser to operate
  local routes,
- local Supabase SMTP cannot be configured without changing tracked secrets,
- fixture expansion requires production data,
- per-worker isolation requires broad product schema changes.
