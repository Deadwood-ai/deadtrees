# DeadTrees Testing Strategy

Use this as the default testing decision tree for DeadTrees work. The goal is
fast development without silent regressions across the product factory.

## Principle

Test-plan-first always. Before changing code, identify the behavior that must
stay true and the cheapest test or smoke check that can prove it.

Strict red-green TDD is useful by default for:

- bug fixes with a known expected behavior
- API/router behavior
- database, RLS, migration, and RPC contracts
- processor utilities and deterministic processor stages
- export/download/storage rules
- refactors where public behavior should not change

Prototype first is acceptable for:

- visual frontend layout and interaction iteration
- OpenLayers/map behavior that needs real browser feedback
- unclear product ergonomics where the right UI is not known yet

Prototype-first work still needs a regression check before merge. The final PR
should either add a durable test or document the exact browser/manual check that
covered the changed behavior.

## Mocking Policy

Avoid mocking internal collaborators just to make tests easy. Prefer tests
through the public interface of the surface being changed.

Use real local fixtures for:

- Supabase/API/router integration
- RLS and database behavior
- local nginx/storage paths
- geospatial fixtures and realistic coordinates
- Mailpit email delivery checks

Mock only at expensive or external boundaries:

- PostHog, Zulip, FreiDATA, third-party APIs, and network-only integrations
- GPU/model inference in fast local tests
- browser APIs that cannot run in Vitest

Every mock must represent a real boundary. If the test fails on an internal
rename while behavior is unchanged, the test is probably too coupled.

## Test Matrix

| Surface                | Default check                                                           | Use when                                                                            |
| ---------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Frontend utility       | `npm --prefix frontend test`                                            | pure data, validation, analytics, routing helpers                                   |
| Frontend static        | `npm --prefix frontend run lint` and `npm --prefix frontend run build`  | TypeScript, lint, React hook, import, and production-build correctness              |
| Repo guardrails        | `scripts/lint-ast-grep.sh`                                             | DeadTrees-specific AST rules for read-only CI safety, secret logging, and browser-test hygiene |
| Frontend browser       | `npm --prefix frontend run test:e2e` or the browser regression playbook | user-facing routes, maps, auth shell, archive/detail/release flows                  |
| Contributor local E2E  | `npm --prefix frontend run test:e2e:local`                              | authenticated upload shell, metadata submission contract, process request contract  |
| Contributor write E2E  | `npm --prefix frontend run test:e2e:local:write`                        | local-only signup, password reset, upload start, download request side effects      |
| Auditor local E2E      | `npm --prefix frontend run test:e2e:local:audit`                        | auditor-only queue triage, audit tabs, processing logs, and audit access guards     |
| Auditor write E2E      | `npm --prefix frontend run test:e2e:local:audit:write`                  | local-only auditor flag, AOI, audit-lock, and audit-save side effects               |
| Python critical lint   | `scripts/lint-python.sh`                                                | syntax/runtime-name safety for API, shared models, processor, CLI, and scripts      |
| API/router             | `scripts/test-api-smoke.sh` or `deadtrees dev test api <path>`          | FastAPI routes, upload/download/process/auth behavior                               |
| Database/RLS/migration | focused API DB tests plus migration review/reset where practical        | schema, policies, RPCs, views, generated contracts                                  |
| Processor CPU          | `deadtrees dev test processor <path>`                                   | queue orchestration, GeoTIFF/COG/metadata, non-GPU utilities                        |
| Processor GPU/model    | processing-server dev checkout                                          | model loading, CUDA/NVIDIA runtime, full combined-model execution, ODM-heavy checks |
| Storage/export         | focused API/export tests plus local nginx/storage fixtures              | signed URLs, download bundles, reference exports, token safety                      |
| Ops/release            | workflow syntax, docs/playbook checks, and post-merge verification plan | GitHub Actions, deploy scripts, cron, release automation                            |

## Required Validation Ladder

1. Run the narrowest test for the changed behavior.
2. Run the surface-level suite when the change touches shared contracts.
3. Add a browser smoke for user-visible frontend changes.
4. Escalate to processing-server validation only for GPU/model/ODM behavior or
   when local non-GPU checks cannot prove the risk.

Frontend build and lint are required frontend gates. Treat failures in
`npm --prefix frontend run lint` or `npm --prefix frontend run build` as
blocking for frontend changes unless the failure is clearly unrelated and
documented.
Run `scripts/lint-ast-grep.sh` after broad implementation changes and before PRs
that touch frontend, Python, scripts, or tests. Add new ast-grep rules only for
repo-specific mistakes that are cheap to detect and expensive to review manually;
do not use ast-grep for subjective style preferences.

`scripts/lint-python.sh` is intentionally a critical-runtime Ruff gate, not a
full style gate. It checks `E9,F63,F7,F82` across Python surfaces so CI catches
syntax errors, invalid control-flow patterns, and undefined names without first
requiring cleanup of the wider existing Ruff debt.

## Data Factory Coverage

Each base product action from `docs/analytics/deadtrees-data-factory.md`
should have at least one durable test or smoke check:

- discovery: home, archive, search/filter/map, releases
- contribution: auth shell, upload validation, GeoTIFF/ZIP handling, queue request
- processing visibility: profile status, failed/stuck states, notifications
- result inspection: dataset detail, COG map, layers, metadata, audit state
- reuse: download states, labels-only download, view-only restrictions, releases
- improvement: issue reporting, correction save, approval/revert
- trust: audit filters, locks, saves, reference patch readiness
- publication: selection, author/ORCID validation, submission state

## Local Contributor Smoke

## API Smoke

Use the API smoke suite when a change touches FastAPI routes, shared database
models/helpers, Supabase migrations, RLS policies, RPC contracts, or local
storage/download behavior:

```bash
supabase start
scripts/test-api-smoke.sh
```

The same command is used by the path-filtered `api-smoke` GitHub Actions
workflow. It starts only the backend-lite test surface: local Supabase, the API
test container, nginx storage, and Mailpit. It intentionally excludes the
processor, GPU/model inference, ODM, and full pipeline validation.

The suite covers:

- API settings/import sanity
- contributor upload and process request contracts
- upload type detection and unsupported ZIP compression rejection
- processing task validation, priority, queue ordering, and rerun behavior
- prepackaged download grant contracts
- DTE stats route validation with synthetic fixtures
- focused download route contracts and bundle helper behavior
- auditor flag review RPC authorization and status history
- private dataset RLS through tables and dataset views
- privileged user visibility and privilege functions
- dataset audit persistence and constraints
- dataset edit history triggers and authorization
- data publication tables and basic publication operations
- notification email rendering and Mailpit delivery

Keep this suite backend-lite. Add processor/GPU/ODM checks to the processing
server validation lane instead of expanding API smoke into full-system testing.

Keep authenticated contributor journeys out of the production-read Playwright
suite. Use the local contributor smoke when a frontend change touches upload,
auth restoration, upload metadata, or process enqueue behavior:

```bash
npm --prefix frontend run test:e2e:local
deadtrees dev test api api/tests/routers/test_contributor_contract_smoke.py
```

The browser smoke uses local/development frontend settings and mocked local
service responses to prove the UI contract without mutating production. The API
contract smoke runs against the repo test stack and proves the same upload and
processing payloads are accepted by FastAPI and persisted to the expected local
test tables/storage paths.

Use the local write-flow suite when auth, upload start, download start, or
local storage side effects are part of the risk:

```bash
supabase start
deadtrees dev start
npm --prefix frontend run test:e2e:local:write
```

This suite is intentionally opt-in and local-only. It signs up a unique local
contributor, requests a password reset through local Supabase Auth, verifies the
reset email through Supabase Mailpit, uploads a small GeoTIFF through the real
local API, asserts dataset/status/ortho/queue rows and archive storage, starts a
download request, and asserts the local download bundle plus download audit log.

## Local Auditor Smoke

Use the local auditor smoke when a frontend change touches audit access,
auditor-only queue triage, completed/reference/edit-review tabs, or processing
visibility:

```bash
npm --prefix frontend run test:e2e:local:audit
deadtrees dev test api api/tests/db/test_auditor_flag_review_contract.py
```

The browser smoke runs against local/development frontend settings and mocked
local Supabase responses. It verifies the auditor access guard, the dashboard's
main queue tabs, processing-log inspection, and the audit-lock navigation
contract without writing to production. The DB contract smoke covers the real
`update_flag_status` RPC with local Supabase side effects: non-auditors are
rejected, auditors can acknowledge and resolve a flag, and status history is
recorded with the acting auditor.

Use the local auditor write-flow suite when the frontend change touches real
auditor write behavior:

```bash
supabase start
deadtrees dev start --services api-test,nginx
npm --prefix frontend run test:e2e:local:audit:write
```

This suite is intentionally opt-in and local-only. It creates unique local
auditor and reporter Auth users, grants the auditor `can_audit`, seeds an
auditable dataset with a local COG, opens the real audit page, acknowledges a
user-reported flag through the `update_flag_status` RPC, draws an AOI, saves the
audit, and asserts real local side effects in `dataset_audit`, `v2_aois`,
`v2_statuses`, `dataset_flags`, and `dataset_flag_status_history`.
