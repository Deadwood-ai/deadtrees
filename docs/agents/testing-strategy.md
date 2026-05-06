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
| Frontend browser       | `npm --prefix frontend run test:e2e` or the browser regression playbook | user-facing routes, maps, auth shell, archive/detail/release flows                  |
| API/router             | `deadtrees dev test api <path>`                                         | FastAPI routes, upload/download/process/auth behavior                               |
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

Do not use currently red global checks as blocking evidence unless the task is
to fix that baseline. As of this strategy, frontend Vitest is the green fast
gate, while frontend build/lint still have unrelated baseline debt.

## Customer Factory Coverage

Each base product action from `docs/analytics/customer-factory-product-map.md`
should have at least one durable test or smoke check:

- discovery: home, archive, search/filter/map, releases
- contribution: auth shell, upload validation, GeoTIFF/ZIP handling, queue request
- processing visibility: profile status, failed/stuck states, notifications
- result inspection: dataset detail, COG map, layers, metadata, audit state
- reuse: download states, labels-only download, view-only restrictions, releases
- improvement: issue reporting, correction save, approval/revert
- trust: audit filters, locks, saves, reference patch readiness
- publication: selection, author/ORCID validation, submission state
