# Database Backup Operations

The production database backup uses a PostgreSQL directory-format dump on the
database host and streams its uncompressed tar representation directly into a
Borg repository on the backup host. This avoids copying a second full dump to
backup-host staging while preserving the existing logical-backup and Borg
restore boundaries.

This playbook contains no credentials. Use the local-only access notes described
in [`../agents/environment-and-access.md`](../agents/environment-and-access.md)
for host access.

## Architecture

The serialized nightly job runs three independent stages in this order:

1. global PostgreSQL objects through the existing `database_dumpall.yaml` job;
2. the direct directory-format database backup;
3. the existing Storage backup through `storage.yaml`.

Each stage runs even if an earlier independent stage fails, while the nightly
wrapper returns a non-zero status if any stage failed. A lock prevents two
nightly sequences from running concurrently.

The direct database stage is split across two least-privilege entry points:

- the backup-host wrapper prepares and verifies the operation, starts the remote
  dump, verifies the committed Borg archive, and runs retention and integrity
  maintenance;
- the database-host forced-command helper only accepts the explicit dump,
  verify, status, transport, tunnel-status, and cleanup operations.

The database is dumped with `pg_dump --format directory --jobs=2 --compress=0`.
After PostgreSQL connections close, the database host sends a tar stream through
a reverse Unix socket to the local Borg repository on the backup host. No
database credentials or Borg keys belong in the repository.

## Authoritative Success Contract

The transport process exiting successfully is not sufficient. The backup-host
wrapper accepts the database stage only when all of these postconditions hold:

- the reverse Unix socket exists and has an active listener before the dump;
- exactly one new `database-dump-*` archive appeared;
- the new archive contains `postgres-directory.tar`;
- a failed transport that committed no archive is retried at most once; a
  committed archive is never retried;
- if transport teardown returned a non-zero status after the archive committed,
  `borg check --archives-only --verify-data` succeeds for that exact archive;
- prune, compact, and the configured Borg check all succeed.

Any missing or ambiguous archive fails closed. Cleanup is attempted when the
wrapper exits, including on errors.

## Installation Contract

The tracked sources map to these production locations:

| Tracked source | Production path |
| --- | --- |
| `scripts/backup/deadtrees-nightly-backups` | `/home/remote-backup/.local/bin/deadtrees-nightly-backups` |
| `scripts/backup/deadtrees-database-backup` | `/home/remote-backup/.local/bin/deadtrees-database-backup` |
| `scripts/backup/deadtrees-db-backup-remote` | `/home/dendro/.local/bin/deadtrees-db-backup-remote` |
| `scripts/backup/database_dump_direct.yaml` | `/home/remote-backup/.config/borgmatic/database_dump_direct.yaml` |

Install executable scripts with mode `0755` and configuration with mode `0600`,
using an atomic replacement and retaining the previous files for rollback. The
remote helper must remain the forced command for its narrowly scoped SSH key.

Only after a full backup and restore-oriented verification pass should the three
legacy simultaneous cron entries be replaced by one serialized entry:

```cron
0 2 * * * /home/remote-backup/.local/bin/deadtrees-nightly-backups
```

Preserve the old crontab before cutover. Do not remove old repositories during
this migration.

## Validation

Before cron cutover, require one complete direct run and verify all of the
following:

```bash
borg list /mnt/raid/backups/supabase.deadtrees.earth
borg list --short /mnt/raid/backups/supabase.deadtrees.earth::ARCHIVE
borg check --archives-only --verify-data --glob-archives ARCHIVE \
  /mnt/raid/backups/supabase.deadtrees.earth
```

The archive listing must contain `postgres-directory.tar`. List the tar contents
through a safe temporary restore path and verify that PostgreSQL has zero dump
sessions afterward. Confirm that both database-host and backup-host staging are
absent, and that retention, compact, and repository checks completed.

For routine monitoring, run the backup surface in
[`platform-status-check.md`](platform-status-check.md). It uses
`database_dump_direct.yaml` so the freshness probe follows the active direct
repository contract.

## Rollback

If the direct run or any verification gate fails, keep the legacy cron entries
and diagnose the failed stage. If a cutover has already occurred and a later
nightly run exposes a transport regression, restore the preserved crontab and
the atomically retained script/configuration versions. Do not delete newly
created archives or alter application data during rollback.
