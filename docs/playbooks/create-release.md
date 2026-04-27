# Release Management

Use this workflow when you want a human-readable project milestone for the
monorepo without changing the existing continuous deployment model.

## Release Model

- production frontend deploys continuously from `main`
- production database migrations apply from `main`
- GitHub Releases are created automatically on pushes to `main`
- the API Docker image is built and pushed as part of the release workflow
- the production processor server has a host-local cron auto-deploy script that
  pulls `main` into `/home/jj1049/prod/deadtrees` and rebuilds the processor
  service
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

Processing server automation is not represented as a GitHub workflow. It is a
host-local cron setup on `processing-server`:

```cron
* * * * * cd /home/jj1049/prod/deadtrees && docker compose -f docker-compose.processor.yaml up
* * * * * /home/jj1049/prod/deadtrees/auto_deploy_processor.sh
```

`/home/jj1049/prod/deadtrees/auto_deploy_processor.sh`:

- operates on `/home/jj1049/prod/deadtrees`
- fetches `origin/main`
- compares local `HEAD` with `origin/main`
- runs `git pull origin main` when a new commit is available
- runs `docker compose -f docker-compose.processor.yaml build processor`
- writes status to `/home/jj1049/prod/deadtrees/auto-deploy.log`

`docker-compose.processor.yaml` builds the processor locally on the processing
server and bind-mounts `./processor`, `./shared`, `./assets`, `/data`, and the
Docker socket. It uses the NVIDIA runtime and does not consume the API image
published by the release workflow.

Useful verification commands:

```bash
ssh processing-server 'crontab -l | grep -E "auto_deploy_processor|docker compose -f docker-compose.processor"'
ssh processing-server 'cd /home/jj1049/prod/deadtrees && git log -1 --oneline --decorate'
ssh processing-server 'cd /home/jj1049/prod/deadtrees && tail -80 auto-deploy.log'
ssh processing-server 'docker ps --format "{{.Names}}\t{{.Status}}\t{{.Image}}" | grep deadtrees-processor'
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
