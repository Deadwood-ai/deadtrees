# Release Management

Use this workflow when you want a human-readable project milestone for the
monorepo without changing the existing continuous deployment model.

## Release Model

- production frontend deploys continuously from `main`
- production database migrations apply from `main`
- GitHub Releases are created automatically on pushes to `main`
- the API Docker image is built and pushed as part of the release workflow
- the production processor server runs one persistent processor container plus
  host-local scripts for deploys and explicit Docker maintenance
- release tags and notes document what reached `main`; they are not a separate
  approval gate

This repository is an application monorepo, not a published package monorepo.
Treat the repo-wide Git tag as the source of truth for releases.

## Production Deployment Automation

Production deployment is split across GitHub Actions and host-local automation.
Future agents should verify both surfaces before judging rollout risk.

GitHub Actions on pushes to `main`:

- `.github/workflows/frontend-hosting-merge.yml` deploys the frontend to the
  Firebase live channel when `frontend/**` changes.
- `.github/workflows/supabase-migrate-on-merge.yml` runs
  `supabase migration up --db-url "$SUPABASE_DB_URL_PROD"` when `supabase/**`
  changes.
- `.github/workflows/create-release.yml` creates the CalVer GitHub Release and
  builds/pushes the API image to `ghcr.io/deadwood-ai/deadwood-api`.

The release is published only after the API image succeeds, so the tag, release,
and container artifact do not intentionally diverge. A rerun for a commit that
already completed reuses its existing same-day CalVer tag and release instead
of creating a duplicate release.

Do not use local/manual SQL as the normal production migration path. If the
Supabase workflow fails, diagnose the workflow failure before proceeding with
dependent host or API changes. For out-of-order migration errors, where a PR
adds a migration timestamped earlier than the latest migration already recorded
in production, prefer a reviewed follow-up migration with a newer timestamp or
an explicit workflow fix. Manual migration repair or direct production SQL
execution should be an explicitly approved emergency action only.

Processing server automation is not represented as a GitHub workflow. It is a
host-local script setup on `processing-server`.

Normal checkout-owner crontab:

```cron
* * * * * cd /home/jj1049/prod/deadtrees && ./scripts/processor_auto_deploy.sh
```

Root crontab, because Snap hold and refresh operations are privileged:

```cron
0 3 * * * cd /home/jj1049/prod/deadtrees && PROCESSOR_SNAP_HOLD_DURATION=7d ./scripts/processor_docker_maintenance.sh --renew-hold-only
```

### One-time legacy cron cutover

Before the first persistent-worker rollout, back up and replace the installed
legacy jobs. Preserve unrelated entries and verify both scheduled users before
starting the new container:

```bash
cd /home/jj1049/prod/deadtrees
mkdir -p .local/cron-backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)"

crontab -l > ".local/cron-backups/checkout-owner-${stamp}.cron" 2>/dev/null || true
awk '!/auto_deploy_processor\.sh/ && !/docker compose .*docker-compose\.processor\.yaml up/ && !/processor_auto_deploy\.sh/' \
  ".local/cron-backups/checkout-owner-${stamp}.cron" > /tmp/deadtrees-checkout-owner.cron
printf '%s\n' '* * * * * cd /home/jj1049/prod/deadtrees && ./scripts/processor_auto_deploy.sh' \
  >> /tmp/deadtrees-checkout-owner.cron
crontab /tmp/deadtrees-checkout-owner.cron

sudo crontab -l > ".local/cron-backups/root-${stamp}.cron" 2>/dev/null || true
awk '!/processor_docker_maintenance\.sh/' ".local/cron-backups/root-${stamp}.cron" \
  > /tmp/deadtrees-root.cron
printf '%s\n' '0 3 * * * cd /home/jj1049/prod/deadtrees && PROCESSOR_SNAP_HOLD_DURATION=7d ./scripts/processor_docker_maintenance.sh --renew-hold-only' \
  >> /tmp/deadtrees-root.cron
sudo crontab /tmp/deadtrees-root.cron

crontab -l
sudo crontab -l
! crontab -l | grep -E 'auto_deploy_processor|docker compose .*docker-compose\.processor\.yaml up'
```

Do not continue the rollout unless the checkout-owner output contains exactly
one tracked auto-deploy job, the root output contains exactly one hold-renewal
job, and neither legacy launcher remains. Restore the timestamped backups if a
verification fails.

Do not reintroduce a per-minute `docker compose up` cron entry. The processor
now runs continuously as `python -m processor.src.continuous_processor` with
`restart: unless-stopped`, so Docker itself keeps the container alive between
tasks and host reboots.

`scripts/processor_auto_deploy.sh`:

- operates on `/home/jj1049/prod/deadtrees`
- acquires a host-local lock so deploy and maintenance operations cannot overlap
- fetches `origin/main`
- compares local `HEAD` with `origin/main`
- records the pre-change SHA and rollback command in `auto-deploy.log`
- creates a drain request so the running worker stops claiming new tasks
- waits for the current host worker to finish its in-flight task
- runs `git pull --ff-only origin main` when a new commit is available
- runs `docker compose -f docker-compose.processor.yaml build processor tcd`
- recreates the processor with `docker compose -f docker-compose.processor.yaml up -d --force-recreate processor`
- clears the drain request after the new container is up
- writes status to `/home/jj1049/prod/deadtrees/auto-deploy.log`

`docker-compose.processor.yaml` builds the processor locally on the processing
server and bind-mounts `./processor`, `./shared`, `./assets`, `/data`, and the
Docker socket. It uses the NVIDIA runtime and does not consume the API image
published by the release workflow.

`scripts/processor_docker_maintenance.sh` is the only approved path for Docker
Snap refreshes or daemon restarts on the processor host. It renews the Snap
hold first, drains the worker, stops the container, runs `snap refresh docker`,
re-applies the hold, restarts the processor, and logs the outcome to
`processor-maintenance.log`.

The `tcd` service is a build-only service (gated behind the `build` profile, so
`docker compose up` never starts it). It exists solely so the deploy rebuilds the
`deadtrees-tcd:latest` tree-cover inference image — which the processor launches
ad-hoc through the Docker socket — from version control. Without `tcd` in the
build command, a Dockerfile change under
`processor/src/treecover_segmentation_oam_tcd/` (e.g. the torch CUDA build) never
reaches production and the processor keeps launching a stale image. The TCD image
build is heavy but layer-cached, so it only does real work when that Dockerfile or
its base image changes.

By default, the processor derives its worker ID from the host machine-id mounted
by `docker-compose.processor.yaml`. Set `PROCESSOR_WORKER_ID` explicitly only
when you need a different stable unique value. Do not reuse the same value on
two simultaneously running processor hosts.

For adding another processor host, use
[`processor-worker-setup.md`](processor-worker-setup.md). Keep this release
playbook focused on verifying the existing production deployment path.

Useful verification commands:

```bash
ssh processing-server 'crontab -l | grep -E "processor_auto_deploy|processor_docker_maintenance"'
ssh processing-server 'cd /home/jj1049/prod/deadtrees && git log -1 --oneline --decorate'
ssh processing-server 'cd /home/jj1049/prod/deadtrees && tail -80 auto-deploy.log'
ssh processing-server 'cd /home/jj1049/prod/deadtrees && python3 scripts/processor_runtime_control.py status'
ssh processing-server 'snap refresh --time'
ssh processing-server 'docker ps --format "{{.Names}}\t{{.Status}}\t{{.Image}}" | grep deadtrees-processor'
ssh processing-server 'docker inspect deadtrees-processor-1 --format "Cmd={{json .Config.Cmd}} RestartPolicy={{.HostConfig.RestartPolicy.Name}}"'
```

For changes that touch `supabase/**`, `api/**`, `processor/**`, or shared task
models, verify after merge that:

- the Supabase migration workflow completed successfully
- the processing server auto-deploy log shows the target commit deployed
- the running `deadtrees-processor` container was rebuilt/restarted from that
  commit

If `/home/jj1049/prod/deadtrees` is dirty or `git pull` conflicts, the cron
auto-deploy may fail even though GitHub Actions succeeded. Check
`auto-deploy.log` before assuming production is on the merged commit.

## Processor Queue Task-Type Quirk

When manually requeueing production datasets to validate segmentation models,
include `geotiff` before any prediction task unless you intentionally want to
reuse the already-standardized raster without refreshing it. The prediction
processors can fetch an existing ortho, but they do not run GeoTIFF
standardization themselves. `geotiff` is the task that standardizes the raster
and refreshes the ortho entry that model stages consume.

Use this task list for an already-uploaded, already-ODM-processed dataset when
you want to compare old and new model outputs:

```json
["geotiff", "deadwood_v1", "treecover_v1", "deadwood_treecover_combined_v2"]
```

Use this full task list for new/raw ZIP processing when all derived products
should be regenerated:

```json
[
  "odm_processing",
  "geotiff",
  "cog",
  "thumbnail",
  "metadata",
  "deadwood_v1",
  "treecover_v1",
  "deadwood_treecover_combined_v2"
]
```

The processor executes `geotiff` before `cog`, `thumbnail`, metadata, and model
stages regardless of the array order, but keep the order explicit in docs and
manual API calls so humans can see the intended pipeline. Legacy model stages
use `is_deadwood_done` and `is_forest_cover_done`; the combined v2 stage uses
`is_combined_model_done` and does not mark the legacy model flags as complete.
Label rows and `model_config` are still the reliable way to confirm which model
variants were actually produced.

## Source Of Truth

- release version: repo-wide CalVer tag such as `v2026.04.17`
- changelog: generated GitHub Release notes
- deployment traceability: Git SHA and image metadata
- package metadata such as `frontend/package.json` is not the release source of
  truth

## Pull Request Expectations

Release notes are only as clean as the merged pull requests.

- PR titles should follow Conventional Commit style
- add area labels when possible so generated release notes group changes well
- add `breaking-change` for changes that need special rollout attention
- add `skip-changelog` for PRs that should stay out of release notes

Suggested labels:

- `frontend`
- `api`
- `database` or `db`
- `supabase`
- `processor`, `processing`, or `pipeline`
- `ci`, `cd`, `github-actions`, or `release`
- `docs`

## CalVer Format

- first release on a day: `vYYYY.MM.DD`
- second release on the same day: `vYYYY.MM.DD.1`
- later releases on the same day: `vYYYY.MM.DD.2`, `vYYYY.MM.DD.3`, and so on

Examples:

- `v2026.04.17`
- `v2026.04.17.1`
- `v2026.05.03`

Use UTC dates in the automation so release tags are deterministic in GitHub
Actions.

## How To Cut A Release

1. Merge the intended change to `main`.
2. The `Create Release` workflow will run automatically on that push.
3. Use manual `workflow_dispatch` only when you need to backfill or rerun a
   release intentionally.
4. For manual runs, leave `target_commitish` as `main` unless you intentionally
   need a specific commit.
5. For manual runs, leave `release_date` empty to use the current UTC date, or
   set it explicitly if you need to backfill a release for a specific day.

The workflow will:

- choose a CalVer base tag for the UTC date
- append a numeric suffix if a release already exists for that day
- build and push the API Docker image tagged with the release version
- create the GitHub Release
- generate release notes using `.github/release.yml`

## Notes

- Do not create release-only commits just to bump versions inside package files.
- If release notes are mis-grouped, fix labels or PR titles before the next
  release rather than editing generated notes by hand.
- Every merge to `main` now creates a release, so release volume will match
  main-branch merge volume.
