import importlib.util
from pathlib import Path

ROOT = Path(__file__).parents[2]
OPERATOR_STATUS = ROOT / 'scripts' / 'operator_status.py'
OPERATOR_SPEC = importlib.util.spec_from_file_location('operator_status_host_tests', OPERATOR_STATUS)
assert OPERATOR_SPEC is not None and OPERATOR_SPEC.loader is not None
operator_status = importlib.util.module_from_spec(OPERATOR_SPEC)
OPERATOR_SPEC.loader.exec_module(operator_status)


def test_additional_processing_hosts_are_labeled_and_validated(monkeypatch):
	monkeypatch.setenv(
		'DEADTREES_OPERATOR_PROCESSING_HOSTS',
		'secondary=secondary-processor,tertiary=operator@tertiary-processor',
	)

	assert operator_status.additional_processing_hosts() == (
		[
			('secondary', 'secondary-processor'),
			('tertiary', 'operator@tertiary-processor'),
		],
		[],
	)

	monkeypatch.setenv('DEADTREES_OPERATOR_PROCESSING_HOSTS', 'secondary=secondary-processor,missing-label')
	assert operator_status.additional_processing_hosts() == (
		[('secondary', 'secondary-processor')],
		['entry 2 must use label=ssh-target'],
	)


def test_host_summaries_keep_legacy_probe_and_deduplicate_extra_target(monkeypatch):
	monkeypatch.setenv('DEADTREES_OPERATOR_PROCESSING_HOST', 'primary-processor')
	monkeypatch.setenv(
		'DEADTREES_OPERATOR_PROCESSING_HOSTS',
		'primary-copy=primary-processor,secondary=secondary-processor',
	)
	probed: list[tuple[str, str]] = []

	def fake_processing_probe(host_ref: str, host: str | None, timeout: int):
		probed.append((host_ref, str(host)))
		return {'ok': True, 'host_ref': host_ref}

	monkeypatch.setattr(operator_status, 'processing_host_probe', fake_processing_probe)
	monkeypatch.setattr(
		operator_status,
		'ssh_probe',
		lambda env_name, command, timeout: {'ok': None, 'host_env': env_name},
	)

	hosts = operator_status.host_summaries(timeout=10)

	assert list(hosts) == ['processing', 'processing:secondary', 'storage', 'backups']
	assert probed == [
		('DEADTREES_OPERATOR_PROCESSING_HOST', 'primary-processor'),
		('DEADTREES_OPERATOR_PROCESSING_HOSTS[secondary]', 'secondary-processor'),
	]


def test_processing_host_probe_requires_running_nonzero_pid(monkeypatch):
	outputs = iter(
		[
			{
				'ok': True,
				'stdout': 'host=worker-a\nprocessor=state=running pid=42 started=now restarts=0 oom=false exit=0',
				'duration_ms': 4,
			},
			{
				'ok': True,
				'stdout': 'host=worker-a\nprocessor=state=running pid=0 started=now restarts=0 oom=false exit=0',
				'duration_ms': 4,
			},
		]
	)
	monkeypatch.setattr(operator_status, 'run_command', lambda *args, **kwargs: next(outputs))

	healthy = operator_status.processing_host_probe('test-host', 'worker-a', timeout=10)
	zombie = operator_status.processing_host_probe('test-host', 'worker-a', timeout=10)

	assert healthy['ok'] is True
	assert healthy['processor']['state'] == 'running'
	assert healthy['processor']['pid'] == 42
	assert zombie['ok'] is False
	assert zombie['error'] == 'processor container reported PID 0'


def test_processing_inspection_gap_preserves_disk_evidence(monkeypatch):
	monkeypatch.setattr(
		operator_status,
		'run_command',
		lambda *args, **kwargs: {
			'ok': False,
			'returncode': 42,
			'stdout': 'host=worker-a\ndisk=/:91%\ndisk=/data:37%',
			'stderr': 'Error: No such object: deadtrees-processor-1',
			'duration_ms': 4,
		},
	)

	probe = operator_status.processing_host_probe('test-host', 'worker-a', timeout=10)

	assert probe['ok'] is None
	assert probe['disks'] == {'/': 91, '/data': 37}
	assert probe['skipped'] == 'Error: No such object: deadtrees-processor-1'
	assert probe['warning'] == probe['skipped']

	snapshot = {
		'repo': {'dirty_count': 0, 'divergence': {'behind': 0}},
		'platform': {'api': {'ok': True}, 'database': {'ok': True}, 'hosts': {'processing:test': probe}},
		'connectors': {},
	}
	verdict, risks, skipped = operator_status.classify(snapshot)
	assert verdict == 'yellow'
	assert 'processing:test' in risks[0]
	assert skipped == ['processing:test']


def test_processing_probe_command_uses_exact_state_and_group_fallback():
	command = operator_status.processing_probe_command()

	assert '.State.Pid' in command
	assert '.State.Status' in command
	assert '.HostConfig.Memory' in command
	assert '.HostConfig.NanoCpus' in command
	assert 'id -nG "$(id -un)"' in command
	assert 'sg docker -c' in command
	assert 'inspect_output=' in command
	assert 'processor container inspection unavailable' not in command
	assert 'exit 42' in command


def test_next_checks_calls_out_a_missing_primary_probe():
	snapshot = {
		'repo': {'divergence': {'behind': 0}},
		'platform': {
			'database': {'ok': True},
			'hosts': {
				'processing': {'ok': None},
				'processing:secondary': {'ok': True},
				'backups': {'ok': True},
			},
		},
	}

	assert 'configure missing primary or additional processing host probes' in operator_status.next_checks(snapshot)


def test_classify_surfaces_processor_oom_state():
	snapshot = {
		'repo': {'dirty_count': 0, 'divergence': {'behind': 0}},
		'platform': {
			'api': {'ok': True},
			'database': {'ok': True},
			'hosts': {
				'processing:secondary': {'ok': True, 'processor': {'oom': True}, 'disks': {}},
			},
		},
		'connectors': {},
	}

	verdict, risks, skipped = operator_status.classify(snapshot)

	assert verdict == 'yellow'
	assert risks == ['processing:secondary processor reports an OOM kill']
	assert skipped == []


def test_host_summaries_probe_valid_hosts_despite_configuration_error(monkeypatch):
	monkeypatch.delenv('DEADTREES_OPERATOR_PROCESSING_HOST', raising=False)
	monkeypatch.setenv(
		'DEADTREES_OPERATOR_PROCESSING_HOSTS',
		'secondary=secondary-processor,missing-label',
	)
	probed: list[str] = []

	def fake_processing_probe(host_ref: str, host: str | None, timeout: int):
		probed.append(str(host))
		return {'ok': True}

	monkeypatch.setattr(operator_status, 'processing_host_probe', fake_processing_probe)
	monkeypatch.setattr(
		operator_status,
		'ssh_probe',
		lambda env_name, command, timeout: {'ok': None, 'host_env': env_name},
	)

	hosts = operator_status.host_summaries(timeout=10)

	assert probed == ['None', 'secondary-processor']
	assert hosts['processing:secondary']['ok'] is True
	assert hosts['processing:configuration']['ok'] is None
	assert hosts['processing:configuration']['warning'] == 'entry 2 must use label=ssh-target'


def test_render_markdown_keeps_failure_cause_with_partial_disk_evidence():
	snapshot = {
		'checked_at': '2026-09-21T08:00:00Z',
		'verdict': 'red',
		'window_hours': 24,
		'repo': {'branch': 'main', 'head': 'abc123', 'dirty_count': 0},
		'platform': {
			'api': {'ok': True, 'version': '1'},
			'database': {'ok': True},
			'hosts': {
				'processing:test': {
					'ok': False,
					'disks': {'/': 91},
					'lines': ['host=test', 'disk=/:91%'],
					'error': 'ssh connection refused',
				},
			},
		},
		'connectors': {},
		'changed_since_last': ['no previous state'],
		'top_risks': ['processing:test host probe failed'],
		'skipped_surfaces': [],
		'next_checks': [],
	}

	markdown = operator_status.render_markdown(snapshot)

	assert 'disks /=91%' in markdown
	assert 'error ssh connection refused' in markdown
