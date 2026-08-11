import importlib.util
import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).parents[2]
DATABASE_BACKUP = ROOT / 'scripts' / 'backup' / 'deadtrees-database-backup'
DATABASE_BACKUP_REMOTE = ROOT / 'scripts' / 'backup' / 'deadtrees-db-backup-remote'
DATABASE_BORG_ARCHIVE = ROOT / 'scripts' / 'backup' / 'deadtrees-db-borg-archive'
DATABASE_BORG_RSH = ROOT / 'scripts' / 'backup' / 'deadtrees-borg-rsh'
NIGHTLY_BACKUPS = ROOT / 'scripts' / 'backup' / 'deadtrees-nightly-backups'
OPERATOR_STATUS = ROOT / 'scripts' / 'operator_status.py'
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
if [[ "$command" == tunnel-status ]]; then
	exit "$FAKE_TUNNEL_STATUS"
fi
if [[ "$command" == cleanup || "$command" == dump || "$command" == verify ]]; then
	exit 0
fi
attempt=0
if [[ -f "$FAKE_ATTEMPTS" ]]; then
	attempt=$(cat "$FAKE_ATTEMPTS")
fi
attempt=$((attempt + 1))
printf '%s\n' "$attempt" >"$FAKE_ATTEMPTS"
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
		'DEADTREES_DB_BACKUP_FLOCK_BIN': str(flock),
		'DEADTREES_DB_BACKUP_RETRY_DELAY': '0',
		'FAKE_ARCHIVES': str(archives),
		'FAKE_ATTEMPTS': str(tmp_path / 'attempts'),
		'FAKE_COMMAND_LOG': str(command_log),
		'FAKE_CREATE_ARCHIVE': '1' if create_archive else '0',
		'FAKE_CREATE_ARCHIVE_ON_ATTEMPT': '1',
		'FAKE_FIRST_TRANSPORT_STATUS': '',
		'FAKE_TRANSPORT_STATUS': str(transport_status),
		'FAKE_TUNNEL_STATUS': '0',
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
	assert 'Expected exactly one new Borg archive, found 0' in result.stderr
	assert 'borgmatic:' not in (tmp_path / 'commands.log').read_text()


def test_transport_retries_once_when_first_attempt_commits_no_archive(tmp_path):
	env = _backup_environment(tmp_path, transport_status=0)
	env['FAKE_CREATE_ARCHIVE_ON_ATTEMPT'] = '2'
	env['FAKE_FIRST_TRANSPORT_STATUS'] = '2'

	result = subprocess.run([DATABASE_BACKUP], env=env, text=True, capture_output=True, check=False)

	assert result.returncode == 0, result.stderr
	assert (tmp_path / 'attempts').read_text() == '2\n'
	assert 'retrying once' in result.stderr


def test_unavailable_tunnel_prevents_database_dump(tmp_path):
	env = _backup_environment(tmp_path, transport_status=0)
	env['FAKE_TUNNEL_STATUS'] = '1'

	result = subprocess.run([DATABASE_BACKUP], env=env, text=True, capture_output=True, check=False)

	assert result.returncode != 0
	commands = (tmp_path / 'commands.log').read_text()
	assert 'ssh:tunnel-status' in commands
	assert 'ssh:dump' not in commands


def test_remote_tunnel_status_requires_listening_socket(tmp_path):
	socket_path = tmp_path / 'borg.sock'
	ss = tmp_path / 'ss'
	socket_test = tmp_path / 'socket-test'
	_write_executable(ss, f'#!/usr/bin/env bash\nprintf "%s\\n" {socket_path}\n')
	_write_executable(socket_test, '#!/usr/bin/env bash\nexit 0\n')
	env = {
		**os.environ,
		'SSH_ORIGINAL_COMMAND': 'tunnel-status',
		'DEADTREES_BORG_SOCKET_PATH': str(socket_path),
		'DEADTREES_SS_BIN': str(ss),
		'DEADTREES_SOCKET_TEST_BIN': str(socket_test),
	}

	result = subprocess.run([DATABASE_BACKUP_REMOTE], env=env, text=True, capture_output=True, check=False)

	assert result.returncode == 0, result.stderr
	assert result.stdout == 'ready\n'


def test_remote_tunnel_status_rejects_stale_socket(tmp_path):
	socket_path = tmp_path / 'borg.sock'
	ss = tmp_path / 'ss'
	socket_test = tmp_path / 'socket-test'
	_write_executable(ss, '#!/usr/bin/env bash\nexit 0\n')
	_write_executable(socket_test, '#!/usr/bin/env bash\nexit 0\n')
	env = {
		**os.environ,
		'SSH_ORIGINAL_COMMAND': 'tunnel-status',
		'DEADTREES_BORG_SOCKET_PATH': str(socket_path),
		'DEADTREES_SS_BIN': str(ss),
		'DEADTREES_SOCKET_TEST_BIN': str(socket_test),
	}

	result = subprocess.run([DATABASE_BACKUP_REMOTE], env=env, text=True, capture_output=True, check=False)

	assert result.returncode != 0


def test_operator_status_checks_direct_database_backup():
	command = operator_status.backup_command()

	assert 'database_dump:database_dump_direct.yaml' in command
	assert 'database_dump:database_dump.yaml' not in command


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
		'DEADTREES_DB_ARCHIVE_BORG_RSH': '/test/borg-rsh',
		'DEADTREES_DB_ARCHIVE_TIMESTAMP': '2026-08-11T11:19:38',
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
		'-o UserKnownHostsFile=/test/known_hosts -o HostKeyAlias=data2-local dendro@test stream-local'
	)


def test_borg_rsh_connects_standard_io_to_reverse_socket(tmp_path):
	command_log = tmp_path / 'socat.log'
	socat = tmp_path / 'socat'
	_write_executable(socat, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >"$FAKE_COMMAND_LOG"\n')
	env = {
		**os.environ,
		'DEADTREES_BORG_RSH_SOCAT_BIN': str(socat),
		'DEADTREES_BORG_RSH_SOCKET_PATH': '/test/borg.sock',
		'FAKE_COMMAND_LOG': str(command_log),
	}

	result = subprocess.run([DATABASE_BORG_RSH], env=env, text=True, capture_output=True, check=False)

	assert result.returncode == 0, result.stderr
	assert command_log.read_text() == 'STDIO UNIX-CONNECT:/test/borg.sock\n'


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
