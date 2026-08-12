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
- the database-host forced-command helper only accepts the explicit prepare,
  dump, capacity, verify, status, preserve, release, and cleanup operations.

The database is dumped with `pg_dump --format directory --jobs=2 --compress=0`.
Before creating the stage, the forced-command helper requires available space to
exceed 300% of the current database size plus a 50 GiB write-safety reserve. A
failed capacity check exits before `pg_dump` writes into the PostgreSQL volume.
Before the dump starts, the wrapper performs a Borg protocol handshake through
the complete reverse-tunnel path. After PostgreSQL connections close, the
database host sends a tar stream through a private `borg`-owned Unix socket to
the dedicated Unix socket on the backup host. The database-host socket uses mode
`0600` inside a mode-`0700` `borg` directory. The backup-host socket uses mode
`0660` inside a mode-`0750` directory shared only by `remote-backup` and the
dedicated `deadtrees-db-tunnel` identity. Its Borg server is restricted to the
database repository only. The database-host SSH policy permits remote forwarding
but forbids local forwarding for `borg`. No database credentials or Borg keys
belong in the repository.

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

Any missing or ambiguous archive fails closed. A stale database-host stage is
removed before the free-space preflight so abandoned dump data cannot cause a
false capacity failure. If no archive is committed, cleanup runs on exit. Before
archive transport starts, a marker inside the dump stage makes that recovery
state persistent across wrapper exits and later scheduled runs. The marker is
released only when a successful repository listing proves that no archive was
committed, or after payload, data, retention, compact, and repository checks all
succeed. A failed or inconclusive validation therefore does not force another
production dump. Operational freshness checks ignore Borg checkpoint archives
and report only completed database backups.

## Installation Contract

The tracked sources map to these production locations:

| Tracked source | Production path |
| --- | --- |
| `scripts/backup/deadtrees-nightly-backups` | `/home/remote-backup/.local/bin/deadtrees-nightly-backups` |
| `scripts/backup/deadtrees-database-backup` | `/home/remote-backup/.local/bin/deadtrees-database-backup` |
| `scripts/backup/deadtrees-db-backup-remote` | `/home/dendro/.local/bin/deadtrees-db-backup-remote` |
| `scripts/backup/deadtrees-db-backup-stream` | `/home/dendro/.local/bin/deadtrees-db-backup-stream` |
| `scripts/backup/deadtrees-db-borg-archive` | `/home/borg/.local/bin/deadtrees-db-borg-archive` |
| `scripts/backup/deadtrees-borg-rsh` | `/home/borg/.local/bin/deadtrees-borg-rsh` |
| `scripts/backup/deadtrees-borg-tunnel-guard` | `/home/borg/.local/bin/deadtrees-borg-tunnel-guard` |
| `scripts/backup/deadtrees-refresh-database-tunnel` | `/home/remote-backup/.local/bin/deadtrees-refresh-database-tunnel` |
| `scripts/backup/database_dump_direct.yaml` | `/home/remote-backup/.config/borgmatic/database_dump_direct.yaml` |
| `scripts/backup/systemd/database-backup-borg.socket` | `/etc/systemd/system/database-backup-borg.socket` |
| `scripts/backup/systemd/database-backup-borg@.service` | `/etc/systemd/system/database-backup-borg@.service` |
| `scripts/backup/systemd/reverse-tunnel@.service` | `/etc/systemd/system/reverse-tunnel@.service` |
| `scripts/backup/sshd_config.d/deadtrees-borg.conf` | `/etc/ssh/sshd_config.d/deadtrees-borg.conf` on the database host |
| `scripts/backup/tmpfiles.d/deadtrees-database-backup.conf` | `/etc/tmpfiles.d/deadtrees-database-backup.conf` on the database host |
| `scripts/backup/tmpfiles.d/deadtrees-database-backup-repository.conf` | `/etc/tmpfiles.d/deadtrees-database-backup-repository.conf` on the backup host |

Install executable scripts with mode `0755` and configuration with mode `0600`,
using an atomic replacement and retaining the previous files for rollback. The
remote helper must remain the forced command for its narrowly scoped SSH key.
The archive helper expects its source-only SSH identity and pinned host key under
`/home/borg/.config/deadtrees-backup/`; these credentials remain host-local. Its
custom Borg RSH connects standard input/output to the private database-host Unix
socket, which forwards to the protected backup-host Unix socket. No direct Borg
SSH key is needed on the backup host.

The backup host uses distinct database-host credentials for three SSH roles:

- `/home/remote-backup/.ssh/id_ed25519` may invoke only the forced
  `deadtrees-db-backup-remote` lifecycle helper and must have forwarding
  disabled;
- `/home/remote-backup/.ssh/id_ed25519_database_archive` may invoke only the
  forced `deadtrees-db-borg-archive` command and must have forwarding disabled;
- `/home/deadtrees-db-tunnel/.ssh/id_ed25519` creates the private
  database-host Unix listener and invokes only the forced
  `deadtrees-borg-tunnel-guard hold` command.

The clients use pinned host keys, and the archive and tunnel clients also set
`IdentitiesOnly=yes` with distinct aliases. The database-host `authorized_keys`
entry for the lifecycle key must use
`from="BACKUP_HOST_SOURCE_ADDRESS",restrict,command="/home/dendro/.local/bin/deadtrees-db-backup-remote"`.
The archive key uses `restrict` with its forced archive command. The tunnel key
uses `from="BACKUP_HOST_SOURCE_ADDRESS",restrict,port-forwarding` with its forced
hold command. The tracked `sshd_config` drop-in restricts the `borg` account to
remote forwarding, keeps gateway ports disabled, and creates stream-local
listeners with mode `0600`. The tunnel private key belongs to a dedicated
backup-host identity whose only shared socket is the database Borg endpoint; it
must have no supplementary groups or access to other repository sockets. The
account policy denies local forwards to database-host services. The tunnel guard
rejects every requested command except its exact hold command.

The source identity at `/home/borg/.config/deadtrees-backup/id_ed25519` must have
a separate `dendro` authorization using
`from="127.0.0.1",restrict,command="/home/dendro/.local/bin/deadtrees-db-backup-stream"`.
The `restrict` option disables TCP and Unix-socket forwarding for this key. The
helper also validates `SSH_ORIGINAL_COMMAND`; attempts to use the source key for
dump, cleanup, or status operations fail closed. Keep all private keys and
concrete public-key lines host-local.

The lifecycle helper's `prepare` and `cleanup` operations refuse to delete a
stage containing `.deadtrees-preserve` and exit `78`. A later scheduled wrapper
therefore stops before `pg_dump` instead of silently discarding recovery data.
After an operator has validated or re-archived the retained dump, explicitly run
`release`, verify the marker is gone with `status`, and only then run `cleanup`.
Do not release a preserved stage merely to make the next nightly job green.

Create the dedicated backup-host identity, then install both tmpfiles and the
SSH policy before starting the tunnel. Replace
`BACKUP_HOST_SOURCE_ADDRESS` in the tunnel key's host-local `authorized_keys`
entry with the source address observed by the database host:

```bash
# Backup host
sudo useradd --system --create-home --user-group \
  --home-dir /home/deadtrees-db-tunnel --shell /usr/sbin/nologin deadtrees-db-tunnel
sudo systemd-tmpfiles --create /etc/tmpfiles.d/deadtrees-database-backup-repository.conf
id -nG deadtrees-db-tunnel
stat -c '%a %U %G %n' /run/deadtrees-database-backup-repository

# Database host
sudo systemd-tmpfiles --create /etc/tmpfiles.d/deadtrees-database-backup.conf
stat -c '%a %U %G %n' /run/deadtrees-database-backup
sudo sshd -t
sudo sshd -T \
  -C user=borg,host=data2.deadtrees.earth,addr=BACKUP_HOST_SOURCE_ADDRESS \
  | grep -E 'allowtcpforwarding|allowstreamlocalforwarding|gatewayports|streamlocalbind'
sudo systemctl reload ssh
sudo -u deadtrees-db-tunnel ssh -T \
  -i /home/deadtrees-db-tunnel/.ssh/id_ed25519 \
  -o ExitOnForwardFailure=yes -o IdentitiesOnly=yes \
  -R /run/deadtrees-database-backup/borg.sock:/run/deadtrees-database-backup-repository/borg.sock \
  borg@data2.deadtrees.earth /home/borg/.local/bin/deadtrees-borg-tunnel-guard hold
```

The dedicated tunnel identity must list only its own primary group. Its
backup-host runtime directory must be mode `0750`, owner `remote-backup`, group
`deadtrees-db-tunnel`; after socket activation, the socket must be mode `0660`
with the same owner and group. The database-host runtime directory must be mode
`0700`, owner and group `borg`. The effective SSH policy must report both TCP and
Unix-socket forwarding as remote-only, disabled gateway ports, mask `0177`, and
stream-local unlink enabled. Stop the foreground verification after the listener
is established, confirm the database-host socket is mode `0600` and owned by
`borg`, then confirm an unrelated local UID cannot connect:

```bash
stat -c '%a %U %G %n' /run/deadtrees-database-backup/borg.sock
sudo -u nobody socat -T1 - UNIX-CONNECT:/run/deadtrees-database-backup/borg.sock
```

The second command must fail with permission denied. A local forward such as
`-L 15432:127.0.0.1:5432` and a stream-local forward such as
`-L /tmp/test.sock:/run/postgresql/.s.PGSQL.5432` must also be rejected by
`sshd`. Make the same negative `-L` and `-R` checks with the lifecycle key while
confirming that its `space-status` command still succeeds. On the backup host,
verify the `deadtrees-db-tunnel` identity can connect to only
`/run/deadtrees-database-backup-repository/borg.sock`; an attempted `socat`
connection to any other repository or service socket must fail before cutover.

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

### Temporary holiday tunnel refresh

The production cutover on 12 August 2026 retained the existing
`remote-backup`-owned shared reverse socket while the least-privilege transport
remains uninstalled. That tunnel had previously stayed active at the systemd
level while its remote socket refused a nightly archive connection. Until
2 September 2026, refresh the tunnel shortly before the serialized backup so a
stale SSH forwarding session cannot survive into the database stage:

```cron
50 1 * * * /home/remote-backup/.local/bin/deadtrees-refresh-database-tunnel
0 2 * * * /home/remote-backup/.local/bin/deadtrees-nightly-backups
```

Install the tracked helper as `remote-backup`, preserve the prior crontab under
`/home/remote-backup/.local/state/borgmatic/`, and keep cron mail enabled. The
helper first acquires the same non-blocking lock as `deadtrees-database-backup`;
if a manual or overlong backup is active, it leaves the tunnel untouched and
exits non-zero. After acquiring the lock, it terminates only the current main process of
`reverse-tunnel@data2.deadtrees.earth.service`; the existing `Restart=always`
policy must replace it with a distinct active PID within 30 seconds. It is silent
on success and exits non-zero with a diagnostic on failure. After a five-second
settle window, it requires the same process to remain active and invokes the
database lifecycle key's `tunnel-status` command. That forced command verifies
the remote Unix socket exists and is an active listener before the refresh can
succeed. The helper also fails closed unless the service is owned by the invoking
user, so it cannot be carried into the dedicated `deadtrees-db-tunnel` deployment
accidentally.

The lifecycle helper keeps `tunnel-status` solely for this temporary guard. Its
default `/tmp/borg.sock` path matches the retained production listener; tests may
override the path and command boundaries. Remove the guard before the dedicated
runtime-directory socket replaces this legacy path.

This is a time-limited reliability guard, not security hardening. It does not
change the shared socket permissions or replace the dedicated transport design
documented above. Review and remove the 01:50 cron entry after 2 September 2026,
then remove the helper after confirming the normal nightly path remains healthy.
Remove this guard before installing the dedicated tunnel identity and unit.

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
sessions afterward. After a successful run, confirm that both database-host and
backup-host staging are absent and that retention, compact, and repository checks
completed. After a failed post-commit validation, confirm instead that the
database-host dump stage reports `preserved`, remains available after a second
wrapper invocation, and is handled through the explicit recovery procedure
before normal scheduling resumes.

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
