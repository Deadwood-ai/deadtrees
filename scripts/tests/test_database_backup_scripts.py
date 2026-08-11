import importlib.util
import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).parents[2]
DATABASE_BACKUP = ROOT / 'scripts' / 'backup' / 'deadtrees-database-backup'
DATABASE_BACKUP_REMOTE = ROOT / 'scripts' / 'backup' / 'deadtrees-db-backup-remote'
DATABASE_BACKUP_STREAM = ROOT / 'scripts' / 'backup' / 'deadtrees-db-backup-stream'
DATABASE_BORG_ARCHIVE = ROOT / 'scripts' / 'backup' / 'deadtrees-db-borg-archive'
DATABASE_BORG_RSH = ROOT / 'scripts' / 'backup' / 'deadtrees-borg-rsh'
DATABASE_BORG_TUNNEL_GUARD = ROOT / 'scripts' / 'backup' / 'deadtrees-borg-tunnel-guard'
BACKUP_SYSTEMD = ROOT / 'scripts' / 'backup' / 'systemd'
BACKUP_SSHD_CONFIG = ROOT / 'scripts' / 'backup' / 'sshd_config.d' / 'deadtrees-borg.conf'
NIGHTLY_BACKUPS = ROOT / 'scripts' / 'backup' / 'deadtrees-nightly-backups'
OPERATOR_STATUS = ROOT / 'scripts' / 'operator_status.py'
PLATFORM_STATUS_PLAYBOOK = ROOT / 'docs' / 'playbooks' / 'platform-status-check.md'
OPERATOR_SPEC = importlib.util.spec_from_file_location('operator_status', OPERATOR_STATUS)
assert OPERATOR_SPEC is not None and OPERATOR_SPEC.loader is not None
operator_status = importlib.util.module_from_spec(OPERATOR_SPEC)
OPERATOR_SPEC.loader.exec_module(operator_status)


def _write_executable(path: Path, content: str) -> None:
	path.write_text(content)
	path.chmod(0o700)


def _backup_environment(tmp_path: Path, *, transport_status: int, create_archive: bool = True) -> dict[str, str]:
	archives = tmp_path / 'archives'
	archives.write_text('')
	command_log = tmp_path / 'commands.log'
	ssh = tmp_path / 'ssh'
	borg = tmp_path / 'borg'
	borgmatic = tmp_path / 'borgmatic'
	flock = tmp_path / 'flock'

	_write_executable(
		ssh,
		"""#!/usr/bin/env bash
set -eu
command="${!#}"
printf 'ssh:%s\n' "$command" >>"$FAKE_COMMAND_LOG"
printf '%s\n' "$*" >>"$FAKE_SSH_ARGS_LOG"
if [[ "$command" == cleanup ]]; then
	touch "$FAKE_CLEANUP_MARKER"
	exit 0
fi
if [[ "$command" == space-status ]]; then
	if [[ "$FAKE_SPACE_REQUIRES_CLEANUP" == 1 && ! -f "$FAKE_CLEANUP_MARKER" ]]; then
		exit 1
	fi
	exit 0
fi
if [[ "$command" == "$FAKE_ARCHIVE_COMMAND probe" ]]; then
	exit "$FAKE_PROBE_STATUS"
fi
if [[ "$command" == dump || "$command" == verify ]]; then
	exit 0
fi
attempt=0
if [[ -f "$FAKE_ATTEMPTS" ]]; then
	attempt=$(cat "$FAKE_ATTEMPTS")
fi
attempt=$((attempt + 1))
printf '%s\n' "$attempt" >"$FAKE_ATTEMPTS"
if [[ "$attempt" -eq 1 && -n "$FAKE_FIRST_ARCHIVE_NAME" ]]; then
	printf '%s\n' "$FAKE_FIRST_ARCHIVE_NAME" >>"$FAKE_ARCHIVES"
fi
if [[ "$FAKE_CREATE_ARCHIVE" == 1 && "$attempt" -ge "$FAKE_CREATE_ARCHIVE_ON_ATTEMPT" ]]; then
	printf 'database-dump-2026-08-11T10:00:00\n' >>"$FAKE_ARCHIVES"
fi
if [[ "$attempt" -eq 1 && -n "$FAKE_FIRST_TRANSPORT_STATUS" ]]; then
	exit "$FAKE_FIRST_TRANSPORT_STATUS"
fi
exit "$FAKE_TRANSPORT_STATUS"
""",
	)
	_write_executable(
		borg,
		"""#!/usr/bin/env bash
set -eu
printf 'borg:%s\n' "$*" >>"$FAKE_COMMAND_LOG"
case "$1" in
	list)
		if [[ "$*" == *'--short'* ]]; then
			printf 'postgres-directory.tar\n'
		else
			cat "$FAKE_ARCHIVES"
		fi
		;;
	check)
		;;
	*)
		exit 64
		;;
esac
""",
	)
	_write_executable(
		borgmatic,
		"""#!/usr/bin/env bash
set -eu
printf 'borgmatic:%s\n' "$*" >>"$FAKE_COMMAND_LOG"
""",
	)
	_write_executable(flock, '#!/usr/bin/env bash\nexit 0\n')

	return {
		**os.environ,
		'DEADTREES_DB_BACKUP_IDENTITY': str(tmp_path / 'identity'),
		'DEADTREES_DB_BACKUP_REMOTE': 'dendro@example.test',
		'DEADTREES_DB_BACKUP_LOCK_FILE': str(tmp_path / 'backup.lock'),
		'DEADTREES_DB_BACKUP_BORGMATIC_BIN': str(borgmatic),
		'DEADTREES_DB_BACKUP_MAINTENANCE_CONFIG': str(tmp_path / 'borgmatic.yaml'),
		'DEADTREES_DB_BACKUP_REPOSITORY': str(tmp_path / 'repository'),
		'DEADTREES_DB_BACKUP_SSH_BIN': str(ssh),
		'DEADTREES_DB_BACKUP_BORG_BIN': str(borg),
		'DEADTREES_DB_BACKUP_ARCHIVE_REMOTE': 'borg@example.test',
		'DEADTREES_DB_BACKUP_ARCHIVE_COMMAND': 'archive-helper',
		'DEADTREES_DB_BACKUP_ARCHIVE_IDENTITY': str(tmp_path / 'archive-identity'),
		'DEADTREES_DB_BACKUP_ARCHIVE_KNOWN_HOSTS': str(tmp_path / 'archive-known-hosts'),
		'DEADTREES_DB_BACKUP_ARCHIVE_HOST_KEY_ALIAS': 'database-archive-test',
		'DEADTREES_DB_BACKUP_FLOCK_BIN': str(flock),
		'DEADTREES_DB_BACKUP_RETRY_DELAY': '0',
		'FAKE_ARCHIVES': str(archives),
		'FAKE_ATTEMPTS': str(tmp_path / 'attempts'),
		'FAKE_COMMAND_LOG': str(command_log),
		'FAKE_SSH_ARGS_LOG': str(tmp_path / 'ssh-args.log'),
		'FAKE_ARCHIVE_COMMAND': 'archive-helper',
		'FAKE_CREATE_ARCHIVE': '1' if create_archive else '0',
		'FAKE_CREATE_ARCHIVE_ON_ATTEMPT': '1',
		'FAKE_CLEANUP_MARKER': str(tmp_path / 'cleanup-complete'),
		'FAKE_SPACE_REQUIRES_CLEANUP': '0',
		'FAKE_FIRST_ARCHIVE_NAME': '',
		'FAKE_FIRST_TRANSPORT_STATUS': '',
		'FAKE_TRANSPORT_STATUS': str(transport_status),
		'FAKE_PROBE_STATUS': '0',
	}


def test_committed_archive_recovers_transport_teardown(tmp_path):
	env = _backup_environment(tmp_path, transport_status=1)

	result = subprocess.run([DATABASE_BACKUP], env=env, text=True, capture_output=True, check=False)

	assert result.returncode == 0, result.stderr
	commands = (tmp_path / 'commands.log').read_text()
	assert 'borg:check --archives-only --verify-data --glob-archives database-dump-2026-08-11T10:00:00' in commands
	assert commands.count('borgmatic:') == 3


def test_transport_failure_without_archive_fails_closed(tmp_path):
	env = _backup_environment(tmp_path, transport_status=1, create_archive=False)

	result = subprocess.run([DATABASE_BACKUP], env=env, text=True, capture_output=True, check=False)

	assert result.returncode != 0
	assert 'Expected exactly one completed new Borg archive, found 0' in result.stderr
	assert 'borgmatic:' not in (tmp_path / 'commands.log').read_text()


def test_transport_retries_once_when_first_attempt_commits_no_archive(tmp_path):
	env = _backup_environment(tmp_path, transport_status=0)
	env['FAKE_CREATE_ARCHIVE_ON_ATTEMPT'] = '2'
	env['FAKE_FIRST_TRANSPORT_STATUS'] = '2'

	result = subprocess.run([DATABASE_BACKUP], env=env, text=True, capture_output=True, check=False)

	assert result.returncode == 0, result.stderr
	assert (tmp_path / 'attempts').read_text() == '2\n'
	assert 'retrying once' in result.stderr


def test_checkpoint_archive_is_incomplete_and_requires_final_archive(tmp_path):
	env = _backup_environment(tmp_path, transport_status=0)
	env['FAKE_FIRST_ARCHIVE_NAME'] = 'database-dump-2026-08-11T10:00:00.checkpoint'
	env['FAKE_CREATE_ARCHIVE_ON_ATTEMPT'] = '2'
	env['FAKE_FIRST_TRANSPORT_STATUS'] = '2'

	result = subprocess.run([DATABASE_BACKUP], env=env, text=True, capture_output=True, check=False)

	assert result.returncode == 0, result.stderr
	assert (tmp_path / 'attempts').read_text() == '2\n'
	assert 'retrying once' in result.stderr
	assert 'database-dump-2026-08-11T10:00:00.checkpoint' in (tmp_path / 'archives').read_text()
	assert (tmp_path / 'commands.log').read_text().count('borgmatic:') == 3


def test_checkpoint_without_final_archive_fails_before_maintenance(tmp_path):
	env = _backup_environment(tmp_path, transport_status=1, create_archive=False)
	env['FAKE_FIRST_ARCHIVE_NAME'] = 'database-dump-2026-08-11T10:00:00.checkpoint'
	env['FAKE_FIRST_TRANSPORT_STATUS'] = '2'

	result = subprocess.run([DATABASE_BACKUP], env=env, text=True, capture_output=True, check=False)

	assert result.returncode != 0
	assert 'Expected exactly one completed new Borg archive, found 0' in result.stderr
	assert 'borgmatic:' not in (tmp_path / 'commands.log').read_text()


def test_unavailable_borg_endpoint_prevents_database_dump(tmp_path):
	env = _backup_environment(tmp_path, transport_status=0)
	env['FAKE_PROBE_STATUS'] = '1'

	result = subprocess.run([DATABASE_BACKUP], env=env, text=True, capture_output=True, check=False)

	assert result.returncode != 0
	commands = (tmp_path / 'commands.log').read_text()
	assert 'ssh:archive-helper probe' in commands
	assert 'ssh:dump' not in commands


def test_archive_connection_uses_dedicated_identity_and_host_alias(tmp_path):
	env = _backup_environment(tmp_path, transport_status=0)

	result = subprocess.run([DATABASE_BACKUP], env=env, text=True, capture_output=True, check=False)

	assert result.returncode == 0, result.stderr
	ssh_args = (tmp_path / 'ssh-args.log').read_text()
	assert f'-i {tmp_path / "archive-identity"}' in ssh_args
	assert '-o IdentitiesOnly=yes' in ssh_args
	assert f'-o UserKnownHostsFile={tmp_path / "archive-known-hosts"}' in ssh_args
	assert '-o HostKeyAlias=database-archive-test' in ssh_args


def test_stale_stage_is_cleaned_before_capacity_preflight(tmp_path):
	env = _backup_environment(tmp_path, transport_status=0)
	env['FAKE_SPACE_REQUIRES_CLEANUP'] = '1'

	result = subprocess.run([DATABASE_BACKUP], env=env, text=True, capture_output=True, check=False)

	assert result.returncode == 0, result.stderr
	commands = (tmp_path / 'commands.log').read_text().splitlines()
	assert commands.index('ssh:cleanup') < commands.index('ssh:space-status') < commands.index('ssh:dump')


def test_remote_dump_rejects_low_capacity_before_pg_dump(tmp_path):
	docker = tmp_path / 'docker'
	pg_dump_marker = tmp_path / 'pg-dump-ran'
	_write_executable(
		docker,
		"""#!/usr/bin/env bash
set -eu
case "$*" in
*" test ! -e "*) exit 0 ;;
*" psql "*) printf '100\n' ;;
*" df -PB1 "*) printf 'Filesystem 1-blocks Used Available Capacity Mounted on\n/dev/test 1000 900 100 90%% /data\n' ;;
*" pg_dump "*) touch "$FAKE_PG_DUMP_MARKER" ;;
*) exit 64 ;;
esac
""",
	)
	env = {
		**os.environ,
		'SSH_ORIGINAL_COMMAND': 'dump',
		'DEADTREES_DOCKER_BIN': str(docker),
		'DEADTREES_DB_BACKUP_CAPACITY_PERCENT': '150',
		'DEADTREES_DB_BACKUP_RESERVE_BYTES': '0',
		'FAKE_PG_DUMP_MARKER': str(pg_dump_marker),
	}

	result = subprocess.run([DATABASE_BACKUP_REMOTE], env=env, text=True, capture_output=True, check=False)

	assert result.returncode != 0
	assert 'Insufficient dump capacity' in result.stderr
	assert not pg_dump_marker.exists()


def test_stream_helper_exposes_only_the_completed_stage(tmp_path):
	docker = tmp_path / 'docker'
	command_log = tmp_path / 'docker.log'
	_write_executable(
		docker,
		'#!/usr/bin/env bash\nprintf "%s\\n" "$*" >>"$FAKE_COMMAND_LOG"\n',
	)
	env = {
		**os.environ,
		'SSH_ORIGINAL_COMMAND': '/test/deadtrees-db-backup-stream',
		'DEADTREES_DB_BACKUP_STREAM_COMMAND_PATH': '/test/deadtrees-db-backup-stream',
		'DEADTREES_DOCKER_BIN': str(docker),
		'FAKE_COMMAND_LOG': str(command_log),
	}

	result = subprocess.run([DATABASE_BACKUP_STREAM], env=env, text=True, capture_output=True, check=False)

	assert result.returncode == 0, result.stderr
	assert command_log.read_text().splitlines() == [
		'exec --user postgres supabase-db test -f /var/lib/postgresql/data/backup-direct/toc.dat',
		'exec --user postgres supabase-db tar --format=posix -C /var/lib/postgresql/data/backup-direct -cf - .',
	]


def test_stream_helper_denies_dump_and_cleanup_commands(tmp_path):
	docker = tmp_path / 'docker'
	docker_marker = tmp_path / 'docker-ran'
	_write_executable(docker, '#!/usr/bin/env bash\ntouch "$FAKE_DOCKER_MARKER"\n')

	for command in ('dump', 'cleanup'):
		env = {
			**os.environ,
			'SSH_ORIGINAL_COMMAND': command,
			'DEADTREES_DB_BACKUP_STREAM_COMMAND_PATH': '/test/deadtrees-db-backup-stream',
			'DEADTREES_DOCKER_BIN': str(docker),
			'FAKE_DOCKER_MARKER': str(docker_marker),
		}
		result = subprocess.run([DATABASE_BACKUP_STREAM], env=env, text=True, capture_output=True, check=False)

		assert result.returncode == 64
		assert result.stderr == 'Command denied.\n'
	assert not docker_marker.exists()


def test_operator_status_checks_direct_database_backup():
	command = operator_status.backup_command()

	assert 'database_dump:database_dump_direct.yaml' in command
	assert 'database_dump:database_dump.yaml' not in command


def test_operator_status_ignores_newer_database_checkpoint(tmp_path):
	borgmatic = tmp_path / 'borgmatic'
	_write_executable(
		borgmatic,
		"""#!/usr/bin/env bash
set -eu
case "$*" in
*database_dump_direct.yaml*)
	printf '%s\n' \
		'database-dump-2026-08-11T10:00:00 Tue, 2026-08-11' \
		'database-dump-2026-08-11T11:00:00.checkpoint Tue, 2026-08-11' \
		'database-dump-2026-08-11T11:30:00.checkpoint.1 Tue, 2026-08-11'
	;;
*storage.yaml*)
	printf '%s\n' 'storage-2026-08-11T12:00:00 Tue, 2026-08-11'
	;;
*) exit 64 ;;
esac
""",
	)
	command = operator_status.backup_command().replace('/home/remote-backup/.local/bin/borgmatic', str(borgmatic))

	result = subprocess.run(['bash', '-c', command], text=True, capture_output=True, check=False)

	assert result.returncode == 0, result.stderr
	assert result.stdout.splitlines() == [
		'archive=database_dump:database-dump-2026-08-11T10:00:00',
		'archive=storage:storage-2026-08-11T12:00:00',
	]


def test_operator_status_fails_when_borgmatic_list_fails_after_output(tmp_path):
	borgmatic = tmp_path / 'borgmatic'
	_write_executable(
		borgmatic,
		"""#!/usr/bin/env bash
printf '%s\n' 'database-dump-2026-08-11T10:00:00 Tue, 2026-08-11'
exit 2
""",
	)
	command = operator_status.backup_command().replace('/home/remote-backup/.local/bin/borgmatic', str(borgmatic))

	result = subprocess.run(['bash', '-c', command], text=True, capture_output=True, check=False)

	assert result.returncode == 2
	assert result.stdout == ''


def test_operator_fallback_documents_completed_archive_filter():
	playbook = PLATFORM_STATUS_PLAYBOOK.read_text()
	command = playbook.split('ssh -o BatchMode=yes -o ConnectTimeout=5 remote-backup@dtbackup', 1)[1].split('```', 1)[0]

	assert 'list --last 1' not in command
	assert '$1 !~ /[.]checkpoint([.][0-9]+)?$/' in command


def test_archive_helper_reproduces_reviewed_production_command(tmp_path):
	command_log = tmp_path / 'archive.log'
	borg = tmp_path / 'borg'
	_write_executable(
		borg,
		"""#!/usr/bin/env bash
set -eu
printf 'rsh=%s\nargs=%s\n' "$BORG_RSH" "$*" >"$FAKE_COMMAND_LOG"
""",
	)
	env = {
		**os.environ,
		'DEADTREES_DB_ARCHIVE_BORG_BIN': str(borg),
		'DEADTREES_DB_ARCHIVE_SSH_BIN': '/test/ssh',
		'DEADTREES_DB_ARCHIVE_REPOSITORY': 'remote-backup@test:/repository',
		'DEADTREES_DB_ARCHIVE_IDENTITY': '/test/identity',
		'DEADTREES_DB_ARCHIVE_KNOWN_HOSTS': '/test/known_hosts',
		'DEADTREES_DB_ARCHIVE_SOURCE_REMOTE': 'dendro@test',
		'DEADTREES_DB_ARCHIVE_SOURCE_COMMAND': '/test/deadtrees-db-backup-stream',
		'DEADTREES_DB_ARCHIVE_BORG_RSH': '/test/borg-rsh',
		'DEADTREES_DB_ARCHIVE_TIMESTAMP': '2026-08-11T11:19:38',
		'DEADTREES_DB_ARCHIVE_COMMAND_PATH': '/test/deadtrees-db-borg-archive',
		'SSH_ORIGINAL_COMMAND': '/test/deadtrees-db-borg-archive archive',
		'FAKE_COMMAND_LOG': str(command_log),
	}

	result = subprocess.run([DATABASE_BORG_ARCHIVE], env=env, text=True, capture_output=True, check=False)

	assert result.returncode == 0, result.stderr
	assert command_log.read_text().strip() == (
		'rsh=/test/borg-rsh\n'
		'args=create --content-from-command --stdin-name postgres-directory.tar --compression zstd,3 --stats '
		'remote-backup@test:/repository::database-dump-2026-08-11T11:19:38 -- '
		'/test/ssh -i /test/identity -o BatchMode=yes -o ConnectTimeout=15 '
		'-o ServerAliveInterval=30 -o ServerAliveCountMax=4 -o StrictHostKeyChecking=yes '
		'-o UserKnownHostsFile=/test/known_hosts -o HostKeyAlias=data2-local '
		'dendro@test /test/deadtrees-db-backup-stream'
	)


def test_archive_helper_probes_borg_endpoint_without_creating_archive(tmp_path):
	command_log = tmp_path / 'archive.log'
	borg = tmp_path / 'borg'
	_write_executable(borg, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >"$FAKE_COMMAND_LOG"\n')
	env = {
		**os.environ,
		'DEADTREES_DB_ARCHIVE_BORG_BIN': str(borg),
		'DEADTREES_DB_ARCHIVE_REPOSITORY': 'remote-backup@test:/repository',
		'DEADTREES_DB_ARCHIVE_COMMAND_PATH': '/test/deadtrees-db-borg-archive',
		'SSH_ORIGINAL_COMMAND': '/test/deadtrees-db-borg-archive probe',
		'FAKE_COMMAND_LOG': str(command_log),
	}

	result = subprocess.run([DATABASE_BORG_ARCHIVE], env=env, text=True, capture_output=True, check=False)

	assert result.returncode == 0, result.stderr
	assert command_log.read_text() == 'info remote-backup@test:/repository\n'


def test_archive_helper_denies_arbitrary_remote_command(tmp_path):
	env = {
		**os.environ,
		'DEADTREES_DB_ARCHIVE_COMMAND_PATH': '/test/deadtrees-db-borg-archive',
		'SSH_ORIGINAL_COMMAND': 'uname -a',
	}

	result = subprocess.run([DATABASE_BORG_ARCHIVE], env=env, text=True, capture_output=True, check=False)

	assert result.returncode == 64
	assert result.stderr == 'Command denied.\n'


def test_borg_rsh_connects_standard_io_to_restricted_reverse_listener(tmp_path):
	command_log = tmp_path / 'socat.log'
	socat = tmp_path / 'socat'
	_write_executable(socat, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >"$FAKE_COMMAND_LOG"\n')
	env = {
		**os.environ,
		'DEADTREES_BORG_RSH_SOCAT_BIN': str(socat),
		'DEADTREES_BORG_RSH_ENDPOINT': '127.0.0.1:42729',
		'FAKE_COMMAND_LOG': str(command_log),
	}

	result = subprocess.run([DATABASE_BORG_RSH], env=env, text=True, capture_output=True, check=False)

	assert result.returncode == 0, result.stderr
	assert command_log.read_text() == 'STDIO TCP:127.0.0.1:42729\n'


def test_tunnel_guard_holds_only_the_expected_forced_command(tmp_path):
	command_log = tmp_path / 'hold.log'
	hold = tmp_path / 'hold'
	_write_executable(hold, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >"$FAKE_COMMAND_LOG"\n')
	env = {
		**os.environ,
		'DEADTREES_BORG_TUNNEL_COMMAND_PATH': '/test/deadtrees-borg-tunnel-guard',
		'DEADTREES_BORG_TUNNEL_HOLD_BIN': str(hold),
		'DEADTREES_BORG_TUNNEL_HOLD_DURATION': 'forever',
		'SSH_ORIGINAL_COMMAND': '/test/deadtrees-borg-tunnel-guard hold',
		'FAKE_COMMAND_LOG': str(command_log),
	}

	result = subprocess.run([DATABASE_BORG_TUNNEL_GUARD], env=env, text=True, capture_output=True, check=False)

	assert result.returncode == 0, result.stderr
	assert command_log.read_text() == 'forever\n'


def test_tunnel_guard_denies_arbitrary_remote_command():
	env = {
		**os.environ,
		'DEADTREES_BORG_TUNNEL_COMMAND_PATH': '/test/deadtrees-borg-tunnel-guard',
		'SSH_ORIGINAL_COMMAND': 'uname -a',
	}

	result = subprocess.run([DATABASE_BORG_TUNNEL_GUARD], env=env, text=True, capture_output=True, check=False)

	assert result.returncode == 64
	assert result.stderr == 'Command denied.\n'


def test_systemd_units_and_sshd_policy_restrict_reverse_transport():
	socket = (BACKUP_SYSTEMD / 'database-backup-borg.socket').read_text()
	server = (BACKUP_SYSTEMD / 'database-backup-borg@.service').read_text()
	tunnel = (BACKUP_SYSTEMD / 'reverse-tunnel@.service').read_text()
	sshd_config = BACKUP_SSHD_CONFIG.read_text()

	assert 'ListenStream=/run/remote-backup/database-borg.sock' in socket
	assert 'Accept=yes' in socket
	assert 'SocketUser=remote-backup' in socket
	assert 'SocketMode=0600' in socket
	assert 'StandardInput=socket' in server
	assert '--restrict-to-path /mnt/raid/backups/supabase.deadtrees.earth' in server
	assert '/mnt/raid/backups/data2.deadtrees.earth' not in server
	assert '/mnt/raid/backups/test' not in server
	assert '-i /home/remote-backup/.ssh/id_ed25519_database_tunnel' in tunnel
	assert '-o IdentitiesOnly=yes' in tunnel
	assert '-o HostKeyAlias=data2-database-tunnel' in tunnel
	assert '-R 127.0.0.1:42729:/run/remote-backup/database-borg.sock' in tunnel
	assert 'borg@%i /home/borg/.local/bin/deadtrees-borg-tunnel-guard hold' in tunnel
	assert 'Restart=always' in tunnel
	assert 'Match User borg' in sshd_config
	assert 'AllowTcpForwarding remote' in sshd_config
	assert 'PermitListen 127.0.0.1:42729' in sshd_config
	assert 'GatewayPorts no' in sshd_config
	assert sshd_config.rstrip().endswith('Match all')


def test_nightly_backup_continues_after_stage_failure(tmp_path):
	command_log = tmp_path / 'nightly.log'
	borgmatic = tmp_path / 'borgmatic'
	database_backup = tmp_path / 'database-backup'
	flock = tmp_path / 'flock'
	_write_executable(
		borgmatic,
		"""#!/usr/bin/env bash
set -eu
printf 'borgmatic:%s\n' "$*" >>"$FAKE_COMMAND_LOG"
if [[ "$*" == *database_dumpall.yaml* ]]; then
	exit 1
fi
""",
	)
	_write_executable(
		database_backup,
		"""#!/usr/bin/env bash
set -eu
printf 'database-backup\n' >>"$FAKE_COMMAND_LOG"
""",
	)
	_write_executable(flock, '#!/usr/bin/env bash\nexit 0\n')
	env = {
		**os.environ,
		'DEADTREES_BORGMATIC_BIN': str(borgmatic),
		'DEADTREES_BORGMATIC_CONFIG_DIR': str(tmp_path),
		'DEADTREES_DATABASE_BACKUP_BIN': str(database_backup),
		'DEADTREES_NIGHTLY_LOCK_FILE': str(tmp_path / 'nightly.lock'),
		'DEADTREES_FLOCK_BIN': str(flock),
		'FAKE_COMMAND_LOG': str(command_log),
	}

	result = subprocess.run([NIGHTLY_BACKUPS], env=env, text=True, capture_output=True, check=False)

	assert result.returncode == 1
	assert command_log.read_text().splitlines() == [
		f'borgmatic:--config {tmp_path}/database_dumpall.yaml',
		'database-backup',
		f'borgmatic:--config {tmp_path}/storage.yaml',
	]
