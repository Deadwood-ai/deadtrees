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
  capacity, verify, status, transport, and cleanup operations.

The database is dumped with `pg_dump --format directory --jobs=2 --compress=0`.
Before creating the stage, the forced-command helper requires available space to
exceed 300% of the current database size plus a 50 GiB write-safety reserve. A
failed capacity check exits before `pg_dump` writes into the PostgreSQL volume.
Before the dump starts, the wrapper performs a Borg protocol handshake through
the complete reverse-tunnel path. After PostgreSQL connections close, the
database host sends a tar stream through that dedicated reverse Unix socket to
the local Borg repository on the backup host. The socket is owned by
`remote-backup` with mode `0600`, and its Borg server is restricted to the
database repository only. No database credentials or Borg keys belong in the
repository.

## Authoritative Success Contract

The transport process exiting successfully is not sufficient. The backup-host
wrapper accepts the database stage only when all of these postconditions hold:

- a read-only Borg repository handshake succeeds through the full tunnel before
  `pg_dump` starts;
- exactly one new `database-dump-*` archive appeared;
- Borg `.checkpoint` archives are treated as incomplete and never satisfy the
  completed-archive postcondition;
- the new archive contains `postgres-directory.tar`;
- a failed transport that committed no archive is retried at most once; a
  committed archive is never retried;
- if transport teardown returned a non-zero status after the archive committed,
  `borg check --archives-only --verify-data` succeeds for that exact archive;
- prune, compact, and the configured Borg check all succeed.

Any missing or ambiguous archive fails closed. Cleanup is attempted when the
wrapper exits, including on errors. A stale database-host stage is removed
before the free-space preflight so abandoned dump data cannot cause a false
capacity failure. Operational freshness checks ignore Borg checkpoint archives
and report only completed database backups.

## Installation Contract

The tracked sources map to these production locations:

| Tracked source | Production path |
| --- | --- |
| `scripts/backup/deadtrees-nightly-backups` | `/home/remote-backup/.local/bin/deadtrees-nightly-backups` |
| `scripts/backup/deadtrees-database-backup` | `/home/remote-backup/.local/bin/deadtrees-database-backup` |
| `scripts/backup/deadtrees-db-backup-remote` | `/home/dendro/.local/bin/deadtrees-db-backup-remote` |
| `scripts/backup/deadtrees-db-borg-archive` | `/home/borg/.local/bin/deadtrees-db-borg-archive` |
| `scripts/backup/deadtrees-borg-rsh` | `/home/borg/.local/bin/deadtrees-borg-rsh` |
| `scripts/backup/deadtrees-borg-tunnel-guard` | `/home/borg/.local/bin/deadtrees-borg-tunnel-guard` |
| `scripts/backup/database_dump_direct.yaml` | `/home/remote-backup/.config/borgmatic/database_dump_direct.yaml` |
| `scripts/backup/systemd/database-backup-borg.socket` | `/etc/systemd/system/database-backup-borg.socket` |
| `scripts/backup/systemd/database-backup-borg@.service` | `/etc/systemd/system/database-backup-borg@.service` |
| `scripts/backup/systemd/reverse-tunnel@.service` | `/etc/systemd/system/reverse-tunnel@.service` |
| `scripts/backup/tmpfiles.d/deadtrees-database-backup.conf` | `/etc/tmpfiles.d/deadtrees-database-backup.conf` on the database host |

Install executable scripts with mode `0755` and configuration with mode `0600`,
using an atomic replacement and retaining the previous files for rollback. The
remote helper must remain the forced command for its narrowly scoped SSH key.
The archive helper expects its source-only SSH identity and pinned host key under
`/home/borg/.config/deadtrees-backup/`; these credentials remain host-local. Its
custom Borg RSH connects standard input/output to the reverse Unix socket, so no
direct Borg SSH key is needed on the backup host.

The backup host uses distinct database-host credentials for the two SSH roles:

- `/home/remote-backup/.ssh/id_ed25519_database_archive` may invoke only the
  forced `deadtrees-db-borg-archive` command and must have forwarding disabled;
- `/home/remote-backup/.ssh/id_ed25519_database_tunnel` may forward the dedicated
  Unix socket and invokes only the forced `deadtrees-borg-tunnel-guard hold`
  command.

Both clients set `IdentitiesOnly=yes` and distinct pinned host-key aliases. The
database-host `authorized_keys` entries must use `restrict` for the archive key
and `restrict,port-forwarding` for the tunnel key, with their respective forced
commands. The tunnel guard rejects every requested command except its exact
hold command, so the forwarding credential cannot execute arbitrary commands.
Keep the two private keys and concrete public-key lines host-local.

On the database host, the tmpfiles configuration provisions
`/run/deadtrees-database-backup` as `borg:borg` mode `0700`. The reverse socket
lives inside this directory, preventing other local users from occupying or
replacing its listener path. Create and verify it before starting the tunnel:

```bash
sudo systemd-tmpfiles --create /etc/tmpfiles.d/deadtrees-database-backup.conf
stat -c '%a %U %G %n' /run/deadtrees-database-backup
```

The expected result is mode `700`, owner `borg`, and group `borg`.

After installing the credential-free unit files, reload systemd and enable the
socket listener plus the database-host tunnel instance:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now database-backup-borg.socket
sudo systemctl enable --now reverse-tunnel@data2.deadtrees.earth.service
systemctl is-active database-backup-borg.socket reverse-tunnel@data2.deadtrees.earth.service
```

The dedicated socket service authorizes only
`/mnt/raid/backups/supabase.deadtrees.earth`; other Borg repositories must use
their own listener and authorization boundary. Do not repurpose this database
tunnel for Storage or test repositories.

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
