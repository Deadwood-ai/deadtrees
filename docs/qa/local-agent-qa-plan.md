# Local Agent QA Platform Plan

## Goal Prompt

Use this prompt as the `/goal` objective for execution:

```text
Implement the approved plan in docs/qa/local-agent-qa-plan.md.

Build a local agent-driven QA platform for DeadTrees that can run extensive
user-journey QA against isolated local worktree environments. Preserve the
existing repo test strategy, keep production untouched, and deliver the plan's
acceptance criteria: isolated stack verification, reusable QA fixture packs,
agent-followable playbooks, a parallel runner, artifact reporting, and browser
tool guidance. Keep changes scoped to local development, QA, docs, scripts, and
test fixtures. Run the validation ladder defined in this plan and produce a
plan-vs-result brief before PR or handoff.
```

## Current State

The first isolation slice exists in this worktree:

- `scripts/dev/isolated-supabase.sh` generates an ignored Supabase workdir under
  `.local/supabase/<worktree-slug>/`.
- The generated stack uses a unique `project_id` and generated port band.
- The light Supabase profile keeps Postgres, Kong, Auth, and PostgREST while
  excluding heavier optional services by default.
- `docker-compose.test.yaml` can consume generated ports, network name, and
  container Supabase URL.
- `frontend/src/config.ts`, `frontend/scripts/run-vite-profile.sh`, and
  `frontend/playwright.local.config.ts` can consume generated local URLs.
- `docs/dev-setup.md` documents the isolated Supabase workflow.

This makes full per-worktree local isolation plausible. The remaining work is
to prove the full local app stack, create deterministic QA data, define
agent-followable journeys, and orchestrate parallel execution.

## Problem

DeadTrees already has repo-native tests and several local browser/API smoke
lanes, but it does not yet have an agent-oriented QA system that can:

- exercise the product as a user across many screens and roles,
- run against fully isolated local environments,
- split product areas across multiple concurrent agents,
- generate durable evidence and failure summaries,
- reset or seed realistic local data for repeated runs,
- choose the right browser control surface for the job.

The target is not to replace Playwright or unit tests. The target is an
operator-grade local QA layer above the existing tests: structured, repeatable
journey scripts that agents can follow, with enough environment isolation and
fixture data to run several journeys in parallel.

## Non-Goals

- Do not mutate production data or production Supabase.
- Do not turn every journey into Playwright tests in this phase.
- Do not build a cloud QA service.
- Do not require Supabase Studio, Realtime, Storage, Edge Runtime, analytics, or
  log services for the default local QA lane.
- Do not solve processor GPU/model validation locally; keep that in the
  processing-server lane from `docs/agents/testing-strategy.md`.
- Do not store real credentials, private tokens, or personal access notes in
  tracked files.

## Assumptions

- Docker is available locally.
- Supabase CLI is available locally.
- The default QA lane can use local Supabase Auth, Postgres, PostgREST, Kong,
  API, nginx, Mailpit, and Vite.
- The local QA system can use ignored `.local/` state for generated stacks,
  run artifacts, temporary credentials, and fixture snapshots.
- Worktree-level isolation is preferred over sharing one Supabase stack across
  multiple worktrees.
- Existing frontend Playwright tests remain useful as regression checks, but
  agent playbooks may be broader, more exploratory, and more product-oriented.

## Constraints

- Keep runtime-generated state under ignored local paths such as `.local/`.
- Preserve the default non-isolated developer workflow.
- Keep production credentials and production data out of tracked docs, fixtures,
  logs, and generated reports.
- Prefer small shell/Python helpers over a new framework unless repeated
  complexity proves that a stronger abstraction is needed.
- Keep the first runner compatible with manual Codex subagent orchestration; do
  not depend on a shell-only subagent primitive that may not exist in every
  Codex surface.
- Do not broaden API smoke, frontend E2E, or processor tests beyond their
  documented responsibilities unless the existing testing strategy is updated.

## Affected Surfaces

- Local environment scripts under `scripts/dev/` and `scripts/qa/`
- Supabase seed or fixture SQL under `supabase/`
- Local API/frontend E2E setup
- `docker-compose.test.yaml`
- Frontend local config and Playwright local config
- Agent-facing QA docs under `docs/qa/`
- Existing testing docs only where they need links to the new QA layer

## Architecture

### Layer 1: Isolated Worktree Environment

Each worktree gets:

- generated Supabase workdir: `.local/supabase/<slug>/`
- generated env file: `.local/supabase/<slug>/env.sh`
- unique Supabase `project_id`
- unique port band
- unique Docker Compose project name
- unique Docker network name
- optional full/light service profile

Required command shape:

```bash
scripts/dev/isolated-supabase.sh start
set -a
source "$(scripts/dev/isolated-supabase.sh env)"
set +a
deadtrees dev start
npm --prefix frontend run dev:local
```

The plan should verify and fix this end-to-end. If `deadtrees dev start`
overrides or ignores generated env values, patch the CLI or add a wrapper rather
than documenting a fragile manual workaround.

### Layer 2: Fixture Packs

QA should use named local fixture packs. A fixture pack is a deterministic seed
that prepares one or more personas and product states.

Initial packs:

| Pack | Purpose |
| --- | --- |
| `qa-base` | public archive/detail/release data, published and unpublished datasets, thumbnail/COG path metadata |
| `qa-auth` | contributor, auditor, and non-privileged users with local Auth identities |
| `qa-contributor` | upload/profile/download/process-request states for contributor journeys |
| `qa-auditor` | audit queue, locks, flags, final assessment, edit-history states |
| `qa-labels` | label/correction datasets with visible map layers and pending approvals |
| `qa-priwa` | PRIWA field workflow rows and edge cases |
| `qa-publication` | publication/release rows, author metadata, reproducibility metadata |
| `qa-negative` | empty states, denied states, invalid rows, failed/stuck processing states |
| `qa-full` | combined pack for broad local QA runs |

Implementation can start as SQL plus helper scripts. If direct Auth user setup
is awkward in SQL, use a small script that calls the local Supabase Auth API and
then writes matching privilege rows.

Required command shape:

```bash
scripts/qa/seed.sh qa-full
scripts/qa/seed.sh qa-auditor
```

The seed command must fail fast if it is pointed at a production-like URL.

### Layer 3: Agent Playbooks

Playbooks are not Playwright tests. They are structured instructions an agent
can execute with Browser, Chrome, or a similar UI automation tool.

Store playbooks under:

```text
docs/qa/playbooks/
```

Recommended format:

```markdown
# <Journey Name>

id: public-archive-discovery
persona: anonymous
fixture_packs: [qa-base]
browser: browser
parallel_safe: true
mutation_level: read-only
routes:
  - /
  - /dataset
  - /dataset/:id

## Purpose

What product behavior this journey proves.

## Preconditions

Environment, seed, credentials, data ids, feature flags.

## Steps

1. Navigate to ...
2. Verify ...
3. Interact with ...

## Expected Observations

- URL/state checks
- visible controls
- data changes if any
- permission boundaries

## Failure Signals

- console errors
- broken network calls
- missing data
- permission leaks
- visual overlap or unusable controls

## Evidence To Capture

- current URL at failure
- focused locator state
- console errors only
- one screenshot only when visual evidence is needed
- database/API assertion if journey mutates state
```

Initial playbook set:

| ID | Persona | Area |
| --- | --- | --- |
| `public-home-discovery` | anonymous | home, navigation, public entry points |
| `public-archive-detail-download` | anonymous | archive filters, dataset detail, download states |
| `public-releases-publications` | anonymous | release/publication discovery |
| `auth-shell` | anonymous/contributor | signup, login, logout, reset email through local Mailpit |
| `contributor-upload-process` | contributor | upload metadata, file validation, process request |
| `contributor-profile-datasets` | contributor | profile, dataset states, failed/stuck visibility |
| `auditor-access-guards` | anonymous/contributor/auditor | audit route permissions |
| `auditor-queue-triage` | auditor | tabs, queue, locks, processing logs |
| `auditor-final-assessment` | auditor | AOI/final assessment save and history |
| `labels-corrections-map` | contributor/auditor | label map, corrections, approval/revert |
| `priwa-field-workflow` | authenticated field user | PRIWA field data creation/edit/soft-delete |
| `negative-empty-error-states` | mixed | empty archive, denied routes, invalid dataset, broken download |

### Browser Tool Policy

Default:

- Use built-in Browser for local app QA.
- Use Chrome only when a real Chrome profile, extension state, or existing
  logged-in browser session is required.
- Use Computer Use only for fallback visual/manual interaction when DOM/browser
  controls are insufficient.

The first runner milestone should perform a comparison on three representative
playbooks and document the result:

- `public-archive-detail-download`
- `auth-shell`
- `auditor-queue-triage`

### Evidence Rules

Keep evidence small and useful:

- Store artifacts under `.local/qa-runs/<timestamp>/`.
- Summarize raw logs; do not paste large logs into chat.
- Capture console errors with tight filters.
- Capture one screenshot only at the failure point.
- Prefer URL, locator state, selected/checked values, and API/DB assertions over
  full DOM dumps.

## Layer 4: Parallel Runner

Add a local runner under:

```text
scripts/qa/run-agent-qa.sh
```

Minimum command:

```bash
scripts/qa/run-agent-qa.sh --profile qa-full --parallel 4
```

Responsibilities:

- verify required local tools,
- verify isolated env is sourced or locate `.local/supabase/current.env`,
- verify Supabase/API/frontend readiness,
- seed requested fixture pack,
- select playbooks,
- split playbooks into parallel worker assignments,
- emit an agent prompt per worker,
- create a run directory,
- collect worker summaries and artifacts,
- generate a final `report.md`.

Because current Codex subagents are orchestration-level rather than a normal
shell primitive, the first implementation may generate worker prompt files and
a manifest instead of launching actual subagents from shell. The main Codex
operator can then spawn subagents using those prompts. Later, if a callable
multi-agent tool is available, the runner can invoke it directly.

The manual pilot procedure is documented in:

```text
docs/qa/parallel-agent-pilot.md
```

Run artifact layout:

```text
.local/qa-runs/<timestamp>/
  manifest.json
  env-summary.json
  worker-01.prompt.md
  worker-01.result.md
  worker-01/
    screenshots/
    console-errors.json
    network-summary.json
  report.md
```

## Milestones

### Milestone 1: Prove Full Local App Isolation

Finish the current isolation foundation.

Tasks:

- Verify `scripts/dev/isolated-supabase.sh start` from a clean local state.
- Verify `deadtrees dev start` consumes generated Compose env.
- Verify `npm --prefix frontend run dev:local` starts on generated frontend port.
- Verify frontend can reach isolated Supabase and local API/nginx.
- Verify `npm --prefix frontend run test:e2e:local` uses generated env.
- Add or patch wrappers if any command still assumes fixed ports.

Acceptance criteria:

- Two isolated worktrees can run Supabase without port collisions.
- This worktree can run Supabase plus app services on generated ports.
- No tracked config file is rewritten at runtime.
- The default non-isolated workflow still works.

Validation:

```bash
scripts/dev/isolated-supabase.sh start
set -a
source "$(scripts/dev/isolated-supabase.sh env)"
set +a
docker compose -f docker-compose.test.yaml config
npm --prefix frontend run lint
npm --prefix frontend run build
```

### Milestone 2: Fixture Pack Foundation

Create deterministic local QA data.

Tasks:

- Inventory existing migrations, API fixtures, frontend E2E setup, and local DB
  tests for reusable data patterns.
- Add seed scripts for `qa-base`, `qa-auth`, `qa-auditor`, and `qa-full`.
- Add a safety guard that refuses production-like Supabase URLs.
- Add a data contract doc listing personas, credentials, dataset IDs, and table
  states without real secrets.
- Add focused smoke checks that prove seeded data exists.

Acceptance criteria:

- `scripts/qa/seed.sh qa-full` prepares data for at least anonymous,
  contributor, and auditor journeys.
- Seed can be rerun after local reset.
- Seed output includes a compact summary of created entities.
- Seed does not require production access.

Validation:

```bash
scripts/qa/seed.sh qa-full
psql "$SUPABASE_DB_URL" -f scripts/qa/check-fixtures.sql
```

### Milestone 3: Playbook Library

Create the agent-followable journey scripts.

Tasks:

- Add the playbook template.
- Write the initial 12 playbooks listed above.
- Tag each playbook with persona, fixture packs, mutation level, browser tool,
  and parallel safety.
- Add a `docs/qa/playbooks/README.md` index.
- Keep each playbook specific enough that a different agent can execute it
  without context from this thread.

Acceptance criteria:

- Every major product surface has at least one playbook.
- Every playbook declares prerequisites and expected evidence.
- Mutating playbooks are clearly separated from read-only playbooks.
- Playbooks include failure signals, not just happy path steps.

Validation:

```bash
scripts/qa/lint-playbooks.sh
```

If a linter is too much for the first pass, use a simple metadata checker that
verifies required headings/fields.

### Milestone 4: Runner And Reporting

Make QA execution repeatable.

Tasks:

- Add `scripts/qa/run-agent-qa.sh`.
- Add playbook selection by tag/persona/mutation level.
- Generate worker prompts and manifest.
- Add run artifact directories.
- Add report aggregation.
- Add readiness checks for Supabase/API/frontend.
- Add a concise failure taxonomy.

Acceptance criteria:

- A single command creates a run directory and worker prompts.
- The report lists pass/fail/blocked/needs-human-review per playbook.
- Each failure points to the smallest useful evidence.
- The runner can split playbooks into at least four workers.

Validation:

```bash
scripts/qa/run-agent-qa.sh --profile qa-full --parallel 4 --dry-run
scripts/qa/run-agent-qa.sh --profile qa-full --parallel 2 --playbook public-home-discovery
```

### Milestone 5: Browser Tool Comparison

Choose the default operating mode from evidence.

Tasks:

- Execute three representative playbooks using built-in Browser.
- Execute the same three with Chrome if tool access is available.
- Attempt one Computer Use fallback pass only for comparison.
- Document speed, reliability, artifact quality, and concurrency constraints.

Acceptance criteria:

- `docs/qa/browser-tool-decision.md` states the default tool and fallbacks.
- The decision includes concrete failure modes and not just preference.
- The runner's generated prompts follow the chosen default.

### Milestone 6: Parallel Agent Pilot

Run the first real multi-agent QA pass.

Tasks:

- Start isolated stack and seed `qa-full`.
- Generate a run with at least six playbooks across at least three workers.
- Execute using subagents from Codex.
- Aggregate reports.
- File follow-up issues or TODOs for product/test gaps discovered.

Acceptance criteria:

- At least three agents can work from generated prompts without needing hidden
  context.
- The final report is useful enough to hand to a developer.
- Re-running the same profile is deterministic enough to compare results.

Current status:

- A full non-dry run executed all 12 playbooks across 4 worker prompts.
- The aggregated pilot report has no pending playbooks and is stored under
  `.local/qa-runs/parallel-pilot-001/report.md`.
- Evidence is recorded in `docs/qa/milestone-6-parallel-pilot-evidence.md`.
  Plan-vs-result closeout is recorded in `docs/qa/plan-vs-result-brief.md`.

## Validation Ladder For The Whole Plan

Use the existing `docs/agents/testing-strategy.md` as the base. For this plan,
the minimum closeout validation should include:

```bash
bash -n scripts/dev/isolated-supabase.sh scripts/qa/*.sh
scripts/dev/isolated-supabase.sh render
docker compose -f docker-compose.test.yaml config
npm --prefix frontend run lint
npm --prefix frontend run build
scripts/lint-ast-grep.sh
```

Add focused checks as implementation grows:

- seed verification SQL,
- playbook metadata lint,
- runner dry run,
- one real read-only playbook execution,
- one real mutating local-only playbook execution.

## Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| Generated ports collide | deterministic port bands plus explicit `DEADTREES_PORT_BASE` override and readiness checks |
| `.env` overrides generated env | source isolated env last in local wrappers and verify effective config |
| Fixture seed becomes brittle | keep packs small, named, and contract-tested |
| Auth users are hard to seed | use local Auth API helper if SQL-only setup is fragile |
| Agent playbooks drift from UI | add metadata lint and periodically run representative playbooks |
| Parallel agents mutate same rows | mark mutation level and use per-worker data suffixes or reset between mutating packs |
| Browser artifacts become noisy | enforce evidence rules and artifact paths |
| Runner tries to become a new test framework | keep it an orchestration layer over existing tests, fixtures, and agent playbooks |

## Rollback Notes

- The default local workflow should remain available by not sourcing the
  isolated env file.
- Generated Supabase state can be stopped with
  `scripts/dev/isolated-supabase.sh stop` and removed from `.local/` if needed.
- New QA fixture data should live in local-only databases; rollback is local DB
  reset plus rerun of the desired fixture pack.
- If the runner design proves too heavy, keep the playbooks and fixture packs
  and replace the runner with a smaller manifest/prompt generator.
- If a browser tool comparison contradicts the default Browser choice, update
  `docs/qa/browser-tool-decision.md` and runner prompts before expanding the
  playbook set.

## Human Decision Points

Ask before changing direction on these:

- Whether fixture data should be committed as SQL, generated by scripts, or both.
- Whether mutating playbooks should share one seeded DB or receive per-worker
  namespaced data.
- Whether to keep runner output as local Markdown/JSON only or also create
  Linear/GitHub issues for failures.
- Whether to invest in callable subagent orchestration if generated worker
  prompts are enough for the first version.
- Whether the default Browser tool decision should change after the comparison
  pass.

## Stop Conditions

Stop and replan if:

- local isolated Supabase cannot run reliably after repeated clean starts,
- the app CLI cannot be made to respect generated env without broad unrelated
  rewrites,
- fixture setup requires production data or credentials,
- browser automation cannot operate local routes reliably enough for evidence,
- parallel mutating journeys create nondeterministic data conflicts that cannot
  be isolated with reasonable namespacing.

## Done Definition

This plan is complete when:

- a fresh worktree can start an isolated local QA stack,
- `qa-full` seed produces named test personas and product states,
- at least 12 playbooks cover the major product surfaces,
- the runner can prepare and report a parallel QA run,
- a pilot run with at least three concurrent agents has produced a report,
- browser tool guidance is documented from actual comparison evidence,
- the existing local/default developer workflow remains intact.
