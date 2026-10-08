# DeadTrees Engineering Rules

## Architecture

DeadTrees is a monorepo:

- `frontend/`: React, TypeScript, Vite, Ant Design, Tailwind, OpenLayers
- `api/`: FastAPI service
- `processor/`: geospatial processing pipeline
- `shared/`: shared settings, models, logging, database helpers
- `supabase/`: schema and migration history
- `deadtrees-cli/`: local developer CLI

Production is split across separate storage and processing roles:

- storage/API server: host nginx, API container, `/data` file storage
- one or more processing hosts: processor, ODM containers, model containers

There is no shared filesystem between the storage server and processor hosts, or
between processor hosts. Data moves through the storage API and SSH file transfer
patterns. Preserve that assumption when changing processor or storage code.

## Delivery

- Work locally or in a dev checkout first.
- Open a normal PR when asked. Do not create draft PRs in this workspace.
- Production deployment is merge-driven from `main`.
- Do not add PR-time workflows that mutate production services or the production DB.
- Do not edit `/home/jj1049/prod/deadtrees` directly unless the user explicitly asks
  for a manual production operation.

## Python And Backend

- Prefer functions for stateless business logic. Classes are appropriate for Pydantic
  models, enums, exceptions, and settings.
- Use tabs in existing tab-indented Python files.
- Keep tests synchronous. Do not add `async def` tests or `@pytest.mark.asyncio`.
- Use real geospatial fixtures and realistic coordinates where practical.
- Use `shared.logging.UnifiedLogger` with `LogContext` for processing/API logs.
- Use `shared.settings.settings` and derived paths instead of hardcoded absolute paths.

## Testing

Use `docs/agents/testing-strategy.md` before choosing test scope, mocks, TDD
style, CI gates, or browser validation. DeadTrees is test-plan-first: decide the
behavior and the cheapest proving surface before changing code.

Use the project CLI for normal validation; reserve `deadtrees dev debug ...` for
sessions where a debugger client will attach.

```bash
source venv/bin/activate   # this checkout's venv; in a worktree, also source .local/supabase/current.env
deadtrees dev test api
deadtrees dev test processor
scripts/lint-python.sh
scripts/lint-ast-grep.sh
scripts/test-api-smoke.sh
npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
npm --prefix frontend run test:e2e
```

Local work is good for API, shared-model, frontend, docs, and non-GPU checks.
Use `scripts/lint-python.sh` for the fast Python critical-runtime lint gate; it
is deliberately narrower than full Ruff cleanup and currently checks syntax,
invalid control flow, and undefined names across API, shared, processor, CLI,
and Python scripts.
Use `scripts/lint-ast-grep.sh` after general code changes that touch frontend,
Python, scripts, or tests. It enforces DeadTrees-specific guardrails that generic
linters do not know: read-only E2E tests stay read-only, frontend code does not
reach for privileged service-role env values, environment values are not logged,
and browser checks avoid broad DOM/text dumps.
Use `scripts/test-api-smoke.sh` for API, shared, Supabase migration, RLS/RPC, or
backend storage/download changes that need the same backend-lite coverage as CI.
For targeted follow-up after the test stack is already running, direct
container pytest is acceptable, for example
`docker compose -f docker-compose.test.yaml exec api-test python -m pytest -v api/tests/routers/test_process.py`.
Run large processor/model validations on the processing-server dev checkout only
when explicitly needed and approved.

## Database

- This section and `docs/agents/environment-and-access.md` own the DeadTrees
  database workflow. A Supabase agent skill is optional; use current official
  documentation for unfamiliar platform behavior.
- Use [trusted analyst access](../playbooks/analyst-database-access.md) for routine
  production inspection, including its target, identity and read-only preflight.
- Configured Supabase/Postgres MCP tools remain useful for local inspection;
  verify their target before use. They are not the routine production SQL route.
- Treat production writes as explicit-approval operations.
- Migrations use the direct database port; application traffic uses the pooler port.
- Name a new migration `<UTC now as YYYYMMDDHHMMSS>_<topic>.sql`, later than every
  file in `supabase/migrations` on current `origin/main`. If a newer migration lands
  on `main` before yours merges, rename yours: the Supabase Migration Guard rejects
  any version at or below the latest one production has applied.
- Drop dependent views before altering referenced columns, then recreate the views.
- Test risky updates in a transaction first and inspect affected counts before commit.
- Review generated migrations for destructive statements, dependency order, RLS
  behavior, and API/TypeScript contract changes.
- Reload the PostgREST schema cache after schema changes when needed.

Common facts:

- File sizes in `v2_orthos` are stored in MB, not bytes.
- Processor auth often needs dual handling for `processor@deadtrees.earth` and normal users.
- `privileged_users` is the privileges table, not `v2_users`.
- Dataset visibility (`public` / `viewonly` / `private`) and named-user grants
  (`dataset_access_grants`: reader with optional download, editor, admin) are
  decided in the database. Row policies use the set-based helpers
  `internal.granted_dataset_ids()` and `internal.hidden_private_dataset_ids()`;
  per-dataset capabilities (download by export kind, edit details, manage
  access) come from `internal.dataset_capabilities()`. New policies, views and
  functions reuse these instead of copying visibility predicates.
- View-only keeps its meaning: anyone can view it and signed-in users can
  download its predictions; only the owner, read-all operators and download
  grants get the orthophoto. Visibility changes go through
  `set_dataset_visibility` (owner only, locked and recorded); a trigger rejects
  direct `data_access` updates by app roles. Grantees edit details only through
  `update_dataset_details`.
- COGs and thumbnails keep one storage path for every visibility. Static
  `/cogs/v1` and `/thumbnails/v1` URLs pass an nginx `auth_request` (cached for
  60 s) that allows only the current file of a public or view-only dataset;
  private files are served on short-lived signed API links through the internal
  `/_protected_data/` location (X-Accel-Redirect).
- Prepared downloads carry a manifest (export kind, dataset IDs, file identity)
  written by `PreparedFileJob`. Delivery is a signed `/api/v1/exports/...` link
  that rechecks download permission for every listed dataset on each request;
  `/downloads/v1` is closed. Files without a matching manifest are rebuilt.
- Production nginx is the host config, not `nginx/api-conf`; follow
  `docs/playbooks/dataset-access-rollout.md` before changing either.

## Processing Pipeline

Typical order:

```text
upload -> odm if raw images -> geotiff -> metadata -> cog -> thumbnail -> deadwood_v1 -> treecover_v1 -> deadwood_treecover_combined_v2 -> aoi_v1 -> embeddings_v1 -> doy_estimation_v1 -> georef_check_v1
```

Critical behavior:

- GeoTIFF standardization creates a local processor file and does not push that
  standardized file back to storage.
- Downstream reruns must include `geotiff` unless the standardized local file is
  known to exist in the same run.
- Do not rerun legacy replacement stages such as `deadwood_v1` or `treecover_v1`
  on datasets that may already have audit edits or geometry corrections. Use
  non-replacing combined-model stages where appropriate.
- `doy_estimation_v1` (acquisition-date model, `docs/doy-estimation.md`) reads the
  stored COG, so it can be rerun alone; bulk reruns go through
  `scripts/requeue_doy_estimation.py`.
- `georef_check_v1` (georeferencing check, `docs/georef-check.md`) also reads the
  stored COG and AOI and can be rerun alone; bulk reruns go through
  `scripts/requeue_georef_check.py`.
- ODM and model stages rely on Docker named volumes to avoid filesystem and UID
  problems across containers.

## Uploads

- Upload code spans `frontend/src/components/Upload/`, `api/src/routers/upload.py`,
  `api/src/upload/`, and shared models/database helpers.
- Chunk uploads use `/api/v1/datasets/chunk`; the frontend chunk size is 50 MB.
- Refresh auth during long uploads and use abort/cancel paths instead of leaving
  orphaned client work.
- Do not submit real production uploads during checks unless the user explicitly
  approves that mutation.
- Handle missing CRS gracefully. Prefer `rasterio.warp.transform_bounds` for
  EPSG:4326 bounds and use settings-derived paths instead of hardcoded paths.

Known production gotchas:

- The processor deploy script is not a liveness watchdog.
- Tar archive handling must stream large archives instead of joining them into memory.
- Phenology assets use the filled path:
  `assets/pheno/modispheno_aggregated_normalized_filled.zarr`.

## Linear

Linear's `deadtrees` team is the shared record of who is working on what. People
and agents follow the same claim rule, so nobody duplicates or collides with work
already underway.

- **Issue first.** Before starting a change, search the team and reuse the
  matching issue, or create one. Use one issue per change.
- **Respect claims.** An issue that is `In Progress` or `In Review` with an
  assignee is taken. Comment on it or ask its assignee; do not start parallel
  work.
- **Claim.** When you start, set the issue to `In Progress`, assign the
  responsible person (for agent work, the person who asked for it), and add a
  one-line comment saying who is doing it and where. Examples: "Claude thread
  *Linear usage check* on processing-server" or "Clemens via Codex".
- **Link.** Name the branch `<type>/<topic>-dt-NNN` (never `claude/` or
  `codex/`, even when a session suggests such a branch name) and end the PR
  title with `(DT-NNN)`. In the PR body, use `Fixes DT-NNN` only when merging
  completes the issue; otherwise use `Related to DT-NNN`.
- **Release.** When work pauses or stops, move the issue back to `Todo` or
  `Backlog` with a one-line note on what remains. An `In Progress` issue with no
  activity for 7 days counts as abandoned in drift checks.
- **Intake is separate.** New findings from monitors, bots and agent checks start
  in `Triage`, unassigned. Agents do not move other people's issues out of
  `Triage` unless the user asks or the task is Linear triage.
- Use labels such as `Bug`, `Feature`, `Improvement`, `Needs RCA`,
  `Needs User Notification`, `frontend`, `processing`, `treecover`, `upload`,
  `metadata`, and `odm` when they match.
- Include dataset IDs, user-visible symptoms, investigation evidence, and links to
  PRs or Zulip threads when available.

## GitHub

- PR titles must be Conventional Commit style and pass the title check.
- Do not prefix PR titles with agent markers such as `[codex]`.
- If a GitHub publishing skill suggests draft PRs or `[codex]` title prefixes,
  follow these repo rules instead: open normal PRs and use Conventional Commit titles.
- Use area labels such as `frontend`, `api`, `database`, `processing`, `ci`, or
  `docs` where available for release-note grouping.

## Communication

- Keep reports compact and evidence-backed.
- Do not dump raw logs, large query output, or secrets.
- For live platform questions, use real surfaces first: DB, API, logs, PostHog,
  Zulip, browser, and host checks as appropriate.
- For Zulip updates, draft first when practical, ask before posting unless the
  user explicitly requested posting, and keep the message short and user-impact
  focused.
- For `/reflect-and-learn` or end-of-session retrospectives, use
  `docs/playbooks/reflect-and-learn.md`. Recommend rule changes only when they
  would have prevented real confusion, waste, or risk in the session.
