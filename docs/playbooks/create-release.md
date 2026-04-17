# Release Management

Use this workflow when you want a human-readable project milestone for the
monorepo without changing the existing continuous deployment model.

## Release Model

- production frontend deploys continuously from `main`
- production database migrations apply from `main`
- GitHub Releases are created automatically on pushes to `main`
- the API Docker image is built and pushed as part of the release workflow
- release tags and notes document what reached `main`; they are not a separate
  approval gate

This repository is an application monorepo, not a published package monorepo.
Treat the repo-wide Git tag as the source of truth for releases.

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
