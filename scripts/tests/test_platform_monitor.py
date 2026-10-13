import argparse
import importlib.util
import json
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[2]
MONITOR = ROOT / 'scripts' / 'platform_monitor'
sys.path.insert(0, str(MONITOR))


def load(name):
	spec = importlib.util.spec_from_file_location(f'platform_monitor_{name}', MONITOR / f'{name}.py')
	assert spec is not None and spec.loader is not None
	module = importlib.util.module_from_spec(spec)
	spec.loader.exec_module(module)
	return module


findings = load('findings')
host_facts = load('host_facts')
monitor_tick = load('monitor_tick')

NOON = datetime(2026, 10, 13, 12, 0, tzinfo=timezone.utc)
NIGHT = datetime(2026, 10, 13, 1, 0, tzinfo=timezone.utc)


def snapshot(**hosts):
	return {'platform': {'api': {'ok': True}, 'database': {'ok': True}, 'hosts': hosts}}


def running(**extra):
	return {'ok': True, 'disks': {'/': 50}, 'processor': {'state': 'running', 'restarts': 0, 'oom': False, **extra}}


def keys(items):
	return {item['fingerprint'] for item in items}


# --- Finding rules ---------------------------------------------------------------


def test_healthy_platform_has_no_findings_or_gaps():
	facts = {'deploy': {'paused': False}, 'prod_oom_kills': [], 'gpu': {'ok': True}, 'workers': [], 'frontend': {'https://deadtrees.earth/': 200}}
	assert findings.build_findings(snapshot(processing=running()), facts, NOON) == ([], [])


def test_processor_state_restarts_and_disks():
	current, _ = findings.build_findings(
		snapshot(
			processing={'ok': False, 'disks': {'/': 86}, 'processor': {'state': 'exited', 'exit': 137, 'restarts': 2}},
			**{'processing:helicon': {'ok': True, 'disks': {'/': 98}, 'processor': {'state': 'running', 'restarts': 0}}},
		),
		{},
		NOON,
	)
	by_key = {item['fingerprint']: item for item in current}
	assert by_key['dt-status/processing-server/processor']['severity'] == 'red'
	assert by_key['dt-status/processing-server/restarts']['severity'] == 'yellow'
	assert by_key['dt-status/processing-server/disk:/']['severity'] == 'yellow'
	# janusch's urgent helicon threshold.
	assert by_key['dt-status/helicon/disk:/']['severity'] == 'red'
	# Red findings sort first.
	assert current[0]['severity'] == 'red'


def test_storage_root_counts_only_above_90_percent_during_the_backup_window():
	storage = {'ok': True, 'disks': {'/': 88, '/data': 86}}
	night, _ = findings.build_findings(snapshot(storage=storage), {}, NIGHT)
	day, _ = findings.build_findings(snapshot(storage=storage), {}, NOON)
	assert keys(night) == {'dt-status/storage/disk:/data'}
	assert keys(day) == {'dt-status/storage/disk:/', 'dt-status/storage/disk:/data'}


def test_storage_status_lines():
	storage = {
		'ok': True,
		'disks': {},
		'lines': [
			'api_checkout=abc1234',
			'api=state=running started=x restarts=1 oom=false',
			'cron=cron_cleanup_downloads.sh present',
			'cron=cron_cleanup_abandoned_uploads_docker.sh missing',
		],
	}
	current, _ = findings.build_findings(snapshot(storage=storage), {'origin_main': 'def5678aaaa'}, NOON)
	assert keys(current) == {
		'dt-status/storage/api-checkout',
		'dt-status/storage/api-restarts',
		'dt-status/storage/cron:cron_cleanup_abandoned_uploads_docker.sh',
	}


def test_failed_probe_is_a_confirmed_finding_and_unconfigured_is_a_gap():
	current, gaps = findings.build_findings(
		snapshot(
			backups={'ok': False, 'error': 'ssh: connection refused'},
			**{'processing:configuration': {'ok': None, 'warning': 'entry 2 must use label=ssh-target'}},
		),
		{},
		NOON,
	)
	assert [(item['fingerprint'], item.get('confirm')) for item in current] == [('dt-status/backups/probe', True)]
	assert 'configuration: entry 2 must use label=ssh-target' in gaps


def test_backup_age_deploy_workers_gpu_oom_and_frontend():
	facts = {
		'deploy': {'paused': True, 'dirty': '?? .env.bak', 'log_errors': ['Refusing to deploy'], 'drain_age_hours': 13},
		'prod_oom_kills': ['python'],
		'gpu': {'error': 'NVIDIA-SMI has failed'},
		'workers': [{'name': 'helicon', 'task_id': 1, 'dataset_id': 2, 'last_log_age_h': 3.4, 'silent': True}],
		'frontend': {'https://deadtrees.earth/': 502},
	}
	current, _ = findings.build_findings(
		snapshot(backups={'ok': True, 'disks': {}, 'archive_ages_hours': {'database_dump': 40.0, 'storage': 3.0}}), facts, NOON
	)
	assert keys(current) == {
		'dt-status/backups/age:database_dump',
		'dt-status/deploy/paused',
		'dt-status/deploy/dirty-checkout',
		'dt-status/deploy/log-error',
		'dt-status/deploy/drain-age',
		'dt-status/processing-server/oom',
		'dt-status/processing-server/gpu',
		'dt-status/helicon/worker-silent',
		'dt-status/frontend/http:https://deadtrees.earth/',
	}
	assert findings.verdict(current) == 'red'


def test_unchecked_local_surfaces_are_gaps_never_green():
	_, gaps = findings.build_findings(snapshot(), {'workers_error': 'OperationalError'}, NOON)
	assert gaps == [
		'deploy health: not checked',
		'processing-server OOM kills: not checked',
		'processing-server GPU: not checked',
		'worker liveness: OperationalError',
	]


# --- Baseline diff ----------------------------------------------------------------


def red(key):
	return findings.finding('red', 'api', key, f'{key} failed')


def test_diff_reports_new_changed_and_cleared():
	first, baseline = findings.diff_findings({}, [red('a'), red('b')])
	assert keys(first['new']) == {'dt-status/api/a', 'dt-status/api/b'}
	yellow_a = findings.finding('yellow', 'api', 'a', 'a degraded')
	second, baseline = findings.diff_findings(baseline, [yellow_a])
	assert [(item['fingerprint'], item['previous_severity']) for item in second['changed']] == [('dt-status/api/a', 'red')]
	assert keys(second['cleared']) == {'dt-status/api/b'}
	third, _ = findings.diff_findings(baseline, [yellow_a])
	assert third == {}


def test_confirmed_findings_need_two_runs_to_open_and_to_clear():
	flaky = findings.finding('yellow', 'deepl1', 'probe', 'deepl1 probe failed', confirm=True)
	delta, baseline = findings.diff_findings({}, [flaky])
	assert delta == {} and baseline['pending'] == {flaky['fingerprint']: 1}
	# One quiet run in between resets the count.
	delta, baseline = findings.diff_findings(baseline, [])
	delta, baseline = findings.diff_findings(baseline, [flaky])
	assert delta == {}
	delta, baseline = findings.diff_findings(baseline, [flaky])
	assert keys(delta['new']) == {flaky['fingerprint']}
	delta, baseline = findings.diff_findings(baseline, [])
	assert delta == {} and flaky['fingerprint'] in baseline['active']
	delta, baseline = findings.diff_findings(baseline, [])
	assert keys(delta['cleared']) == {flaky['fingerprint']}


# --- Host facts -------------------------------------------------------------------


def test_oom_kills_count_only_in_the_prod_cgroup():
	journal = '\n'.join([
		'2026-10-13T04:02:00 kernel: oom-kill:constraint=CONSTRAINT_MEMCG,oom_memcg=/system.slice/docker-aaaaaaaaaaaa1234.scope,task=x',
		'2026-10-13T04:02:00 kernel: Memory cgroup out of memory: Killed process 1 (odm) total-vm:1kB',
		'2026-10-13T04:03:00 kernel: oom-kill:constraint=CONSTRAINT_MEMCG,oom_memcg=/system.slice/docker-bbbbbbbbbbbb5678.scope,task=y',
		'2026-10-13T04:03:00 kernel: Memory cgroup out of memory: Killed process 2 (pytest) total-vm:1kB',
	])
	assert host_facts.parse_oom_kills(journal, 'aaaaaaaaaaaa') == ['odm']
	assert host_facts.parse_oom_kills(journal, 'cccccccccccc') == []


def test_deploy_log_ignores_normal_drain_messages():
	lines = [
		'2026-10-13T10:00:00Z: No changes',
		'another processor runtime operation already holds processor-runtime.lock',
		'Worker still busy on task 5; keeping the drain',
		'Refusing to deploy: checkout is dirty',
	]
	assert host_facts.deploy_log_errors(lines) == ['Refusing to deploy: checkout is dirty']


def test_drain_age_from_the_runtime_status():
	status = {'drain_request': {'requested_at': '2026-10-13T00:00:00Z'}}
	assert host_facts.parse_drain_age(status, NOON) == 12.0
	assert host_facts.parse_drain_age({'drain_request': None}, NOON) is None


# --- Model receipts ---------------------------------------------------------------


def result(text, tools=('list_issues', 'search_threads', 'exec'), turns=5):
	return {'result': text, 'tools_called': sorted(tools), 'num_turns': turns}


def test_inbox_receipt_needs_proven_reads():
	text = '[linear] [DT-1](https://linear.app/x/DT-1): asks you\n[checked] linear=3 gmail=0 posthog=0 project=13440'
	items, checked, ok, posthog_ok = monitor_tick.inbox_lines(result(text))
	assert (items, checked, ok, posthog_ok) == (
		['- [linear] [DT-1](https://linear.app/x/DT-1): asks you'], 'linear=3 gmail=0 posthog=0 project=13440', True, True
	)
	# A receipt without the session's own reads keeps no items.
	items, checked, ok, _ = monitor_tick.inbox_lines(result(text, tools=('list_issues',)))
	assert (checked, ok) == ('inbox unchecked', False) and items[0].startswith('- [gap]')
	items, checked, ok, _ = monitor_tick.inbox_lines(result('[gmail] none', turns=1))
	assert (checked, ok) == ('inbox unchecked', False)


def test_posthog_in_another_project_is_a_gap_and_its_items_are_dropped():
	text = '[posthog] id=abc occurrences=3 users=1 first_seen=2026-10-13T11:00:00Z name=TypeError\n[checked] linear=1 gmail=1 posthog=1 project=298921'
	items, _, ok, posthog_ok = monitor_tick.inbox_lines(result(text))
	assert ok and not posthog_ok
	assert items == ['- [gap] posthog: not read in project 13440 (reported 1, project 298921)']


def test_placeholder_items_are_not_items():
	items, _, ok, _ = monitor_tick.inbox_lines(result('[gmail] none\n[zulip] nothing new\n[checked] linear=0 gmail=0 posthog=0 project=13440'))
	assert ok and items == []


def test_posthog_issues_are_filed_once_and_again_only_on_a_spike():
	line = '- [posthog] id=e1 occurrences={} users=1 first_seen=2026-10-13T11:00:00Z name=TypeError: x is undefined'
	items = monitor_tick.posthog_items([line.format(2)])
	delta, seen = monitor_tick.posthog_delta(items, {})
	assert [item['fingerprint'] for item in delta['new']] == ['dt-status/posthog/error:e1']
	assert 'project/13440/error_tracking/e1' in delta['new'][0]['summary']
	delta, seen = monitor_tick.posthog_delta(monitor_tick.posthog_items([line.format(4)]), seen)
	assert delta == {}
	delta, seen = monitor_tick.posthog_delta(monitor_tick.posthog_items([line.format(12)]), seen)
	assert delta['changed'][0]['summary'].startswith('spiking: ')


def test_haiku_cost_uses_the_list_price():
	usage = {'claude-haiku-5-5': {'costBasis': 'unknown', 'costUSD': 0.5, 'cacheReadInputTokens': 1_000_000, 'outputTokens': 1_000_000}}
	assert monitor_tick.call_cost({'modelUsage': usage}) == pytest.approx(0.51)
	assert monitor_tick.call_cost({'modelUsage': {'claude-sonnet-5-5': {'costUSD': 0.2}}}) == pytest.approx(0.2)


def fake_claude(tmp_path, events, stderr='[claude-code:unrecognized_model] {"model":"claude-haiku-5-5"}'):
	script = tmp_path / 'claude'
	lines = '\n'.join(json.dumps(event) for event in events)
	script.write_text(f"#!/bin/sh\ncat >/dev/null\necho '{stderr}' >&2\ncat <<'EOF'\nnot json\n{lines}\nEOF\n")
	script.chmod(script.stat().st_mode | stat.S_IEXEC)
	return argparse.Namespace(claude=str(script), model='claude-haiku-5-5', budget_usd=3.0)


def test_ask_model_reads_stdout_events_and_the_tools_really_called(tmp_path):
	events = [
		{'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'name': 'mcp__claude_ai_Linear__list_issues'}]}},
		{'type': 'result', 'subtype': 'success', 'result': '[checked] x', 'num_turns': 3},
		{'type': 'system', 'subtype': 'done'},
	]
	answer = monitor_tick.ask_model('prompt', ('a',), fake_claude(tmp_path, events), tmp_path)
	assert answer['result'] == '[checked] x' and answer['tools_called'] == ['list_issues']


def test_ask_model_without_a_result_event_fails(tmp_path):
	with pytest.raises(RuntimeError):
		monitor_tick.ask_model('prompt', ('a',), fake_claude(tmp_path, []), tmp_path)


def test_filing_fails_when_a_fingerprint_got_no_issue(tmp_path, monkeypatch):
	delta = {'new': [red('a'), red('b')]}
	answer = {
		'result': '[filed] dt-status/api/a=DT-9\n[filed] ok', 'num_turns': 4, 'tools_called': ['save_issue'], 'modelUsage': {},
	}
	monkeypatch.setattr(monitor_tick, 'ask_model', lambda *args, **kwargs: answer)
	args = argparse.Namespace(state_dir=tmp_path)
	ok, detail, filed, _ = monitor_tick.file_findings(delta, {}, NOON, args, tmp_path)
	assert not ok and 'dt-status/api/b' in detail and filed == {'dt-status/api/a': 'DT-9'}


def test_filing_without_a_linear_write_never_counts(tmp_path, monkeypatch):
	answer = {'result': '[filed] dt-status/api/a=DT-9\n[filed] ok', 'num_turns': 4, 'tools_called': [], 'modelUsage': {}}
	monkeypatch.setattr(monitor_tick, 'ask_model', lambda *args, **kwargs: answer)
	ok, detail, _, _ = monitor_tick.file_findings({'new': [red('a')]}, {}, NOON, argparse.Namespace(state_dir=tmp_path), tmp_path)
	assert not ok and detail == 'the model did not make its Linear calls'


# --- Tick -------------------------------------------------------------------------


def run_tick(tmp_path, monkeypatch, filing_ok=True, posthog_line=''):
	monkeypatch.setattr(monitor_tick, 'run_script', lambda name, extra: snapshot(api={}) | {'ok': True} if 'scorecard' in name else snapshot())
	monkeypatch.setattr(monitor_tick.host_facts, 'collect', lambda now: {'deploy': {}, 'gpu': {'ok': True}, 'workers': [], 'prod_oom_kills': []})
	monkeypatch.setattr(monitor_tick.findings_module, 'build_findings', lambda *args: ([red('a')], []))
	inbox = {
		'result': f'{posthog_line}\n[checked] linear=0 gmail=0 posthog=1 project=13440', 'num_turns': 5,
		'tools_called': ['exec', 'list_issues', 'search_threads'], 'modelUsage': {},
	}
	monkeypatch.setattr(monitor_tick, 'ask_model', lambda *args, **kwargs: inbox)
	filed = {}

	def file_findings(delta, known, now, args, workdir):
		filed['delta'] = delta
		return filing_ok, '[filed] ok' if filing_ok else 'boom', {'dt-status/api/a': 'DT-7'} if filing_ok else {}, 0.0

	monkeypatch.setattr(monitor_tick, 'file_findings', file_findings)
	args = monitor_tick.parse_args(['--state-dir', str(tmp_path), '--zuliprc', str(tmp_path / 'missing')])
	assert monitor_tick.tick(args, NOON, tmp_path) == 0
	return filed.get('delta'), json.loads((tmp_path / 'monitor.json').read_text())


def test_tick_files_the_delta_and_advances_the_baseline(tmp_path, monkeypatch):
	posthog = '[posthog] id=e1 occurrences=2 users=1 first_seen=2026-10-13T11:00:00Z name=TypeError'
	delta, state = run_tick(tmp_path, monkeypatch, posthog_line=posthog)
	assert [item['fingerprint'] for item in delta['new']] == ['dt-status/api/a', 'dt-status/posthog/error:e1']
	assert state['issues'] == {'dt-status/api/a': 'DT-7'}
	assert state['posthog_seen'] == {'e1': 2}
	assert state['inbox_since'] == '2026-10-13T12:00:00Z'
	assert 'dt-status/api/a' in json.loads((tmp_path / 'monitor-findings.json').read_text())['active']
	digest = (tmp_path / 'digest-latest.md').read_text()
	assert 'new red: a failed [DT-7]' in digest


def test_failed_filing_keeps_the_baseline_for_a_retry(tmp_path, monkeypatch):
	_, state = run_tick(tmp_path, monkeypatch, filing_ok=False)
	assert not (tmp_path / 'monitor-findings.json').exists()
	assert state['posthog_seen'] == {}
	assert 'linear filing failed, will retry' in (tmp_path / 'digest-latest.md').read_text()


def test_shadow_runs_in_the_first_tick_of_each_hour_until_its_end():
	args = argparse.Namespace(shadow_model='claude-sonnet-5-5', shadow_until='2026-10-20T12:00Z')
	assert monitor_tick.shadow_due(args, NOON)
	assert not monitor_tick.shadow_due(args, NOON.replace(minute=15))
	assert not monitor_tick.shadow_due(args, NOON.replace(day=21))
	assert not monitor_tick.shadow_due(argparse.Namespace(shadow_model='x', shadow_until='soon'), NOON)
