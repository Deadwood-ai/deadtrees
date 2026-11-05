import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).parents[2]
MONITOR = ROOT / 'scripts' / 'platform_monitor'
sys.path.insert(0, str(MONITOR))

import board_wait  # noqa: E402
import findings  # noqa: E402
import platform_board  # noqa: E402

NOON = datetime(2026, 11, 5, 12, 0, tzinfo=timezone.utc)
RELEASE = {'activated': 'e97e0a35243a'}


def healthy_host(**extra):
	return {'ok': True, 'disks': {'/': 40}, **extra}


def processor(**extra):
	return healthy_host(processor={'state': 'running'}, release=RELEASE, **extra)


def snapshot(**hosts):
	base = {
		'storage': healthy_host(),
		'processing': processor(),
		'processing:helicon': processor(),
		'processing:deepl1': processor(),
		'backups': {'ok': True, 'archive_ages_hours': {'database_dump': 11.4, 'storage': 11.0}},
	}
	return {
		'platform': {
			'api': {'ok': True, 'status': 200, 'version': '0.8.4'},
			'database': {'ok': True},
			'hosts': {**base, **hosts},
		}
	}


def facts(**extra):
	return {
		'origin_main': 'e97e0a35243a',
		'deploy': {'paused': False},
		'main_ci': {'migrate': {'conclusion': 'success'}, 'frontend deploy': {'conclusion': 'success'}},
		'prod_oom_kills': [],
		'gpu': {'ok': True},
		'workers': [],
		'frontend': {'https://deadtrees.earth/': 200},
		**extra,
	}


def rows(snap=None, fact=None, active=None, unobserved=(), issues=None, posthog=None):
	return platform_board.build_rows(
		snap or snapshot(), fact or facts(), active or {}, list(unobserved), issues or {}, posthog or {'read': True, 'recent': {}},
	)


def states(built):
	return {row['name']: row['state'] for row in built}


def row(built, name):
	return next(item for item in built if item['name'] == name)


def tracked(severity, surface, key, summary='it broke'):
	return {f'dt-status/{surface}/{key}': findings.finding(severity, surface, key, summary)}


def test_all_rows_show_in_order_and_green_when_everything_was_read():
	built = rows()
	assert [item['name'] for item in built] == [name for name, _ in platform_board.ROWS]
	assert set(states(built).values()) == {platform_board.GREEN}


def test_a_row_takes_its_worst_finding_and_links_its_issues():
	active = {
		**tracked('yellow', 'storage', 'disk:/data', 'full'),
		**tracked('red', 'api', 'smoke', 'down'),
		**tracked('yellow', 'deepl1', 'disk:/', 'deepl1 is 87% full'),
	}
	issues = {'dt-status/storage/disk:/data': 'DT-2', 'dt-status/api/smoke': 'DT-1', 'dt-status/deepl1/disk:/': 'DT-3'}
	built = rows(active=active, issues=issues)
	assert row(built, 'data2')['state'] == platform_board.RED
	assert row(built, 'data2')['issues'] == ['DT-1', 'DT-2']
	assert row(built, 'deepl1')['state'] == platform_board.YELLOW
	assert row(built, 'helicon')['state'] == platform_board.GREEN


def test_a_failed_probe_is_unknown_never_green_and_keeps_the_link():
	down = {'ok': False, 'disks': {}, 'error': 'Connection timed out during banner exchange'}
	active = tracked('yellow', 'helicon', 'probe', 'probe failed')
	built = rows(
		snapshot(**{'processing:helicon': down}), active=active, issues={'dt-status/helicon/probe': 'DT-925'},
	)
	helicon = row(built, 'helicon')
	assert helicon['state'] == platform_board.UNKNOWN
	assert helicon['issues'] == ['DT-925']
	assert helicon['detail'] == 'not read: Connection timed out during banner exchange'


def test_earlier_findings_of_an_unread_source_stay_unknown_not_red():
	down = {'ok': False, 'disks': {}, 'error': 'timeout'}
	active = tracked('red', 'helicon', 'processor', 'exited')
	built = rows(
		snapshot(**{'processing:helicon': down}), active=active, unobserved=findings.host_patterns('helicon'),
		issues={'dt-status/helicon/processor': 'DT-9'},
	)
	assert row(built, 'helicon')['state'] == platform_board.UNKNOWN
	assert row(built, 'helicon')['issues'] == ['DT-9']


def test_each_unread_source_turns_its_row_white():
	checks = {
		'data2': (snapshot() | {'platform': {**snapshot()['platform'], 'database': {'ok': None}}}, facts()),
		'website': (snapshot(), facts(frontend={})),
		'deploys': (snapshot(), facts(main_ci=None)),
		'processing server': (snapshot(), facts(gpu={})),
		'backups': (snapshot(backups={'ok': False, 'error': 'x'}), facts()),
	}
	for name, (snap, fact) in checks.items():
		assert row(rows(snap, fact), name)['state'] == platform_board.UNKNOWN, name
	# No queue read: the processors cannot be called green.
	assert row(rows(fact=facts(workers=None)), 'deepl1')['state'] == platform_board.UNKNOWN


def test_a_finding_observed_this_tick_beats_an_unread_source():
	active = tracked('yellow', 'deepl1', 'disk:/', 'full')
	assert row(rows(fact=facts(workers=None), active=active), 'deepl1')['state'] == platform_board.YELLOW


def test_app_errors_come_from_the_proven_read():
	assert row(rows(posthog={'read': False, 'recent': {'a': 'x'}}), 'app errors')['state'] == platform_board.UNKNOWN
	assert row(rows(posthog={'read': True, 'recent': {}}), 'app errors')['state'] == platform_board.GREEN
	yellow = row(rows(posthog={'read': True, 'recent': {'a': 'x'}, 'issue': 'DT-1519'}), 'app errors')
	assert yellow['state'] == platform_board.YELLOW
	assert yellow['issues'] == ['DT-1519']
	assert yellow['detail'] == '1 new or spiking in 24 h'


def test_recent_errors_are_forgotten_after_a_day():
	old = (NOON - timedelta(hours=25)).isoformat().replace('+00:00', 'Z')
	fresh = (NOON - timedelta(hours=2)).isoformat().replace('+00:00', 'Z')
	kept = platform_board.recent_errors({'old': old, 'fresh': fresh}, ['new'], NOON)
	assert set(kept) == {'fresh', 'new'}


def test_row_details_name_what_each_processor_is_doing():
	worker = {'name': 'processing-server', 'dataset_id': 15606, 'step': 'odm_processing'}
	built = rows(fact=facts(workers=[worker]))
	assert row(built, 'processing server')['detail'] == 'running, dataset 15606 (odm_processing), disk / 40%, on e97e0a3'
	assert row(built, 'deepl1')['detail'] == 'running, idle, disk / 40%, on e97e0a3'
	assert row(built, 'data2')['detail'] == 'API 200 v0.8.4, database ok, disk / 40%'
	assert row(built, 'backups')['detail'] == 'database 11h, storage 11h old'
	assert row(built, 'deploys')['detail'] == 'main e97e0a3, migrate success, frontend deploy success'


def test_render_is_a_headline_plus_one_line_per_row():
	scorecard = {'ok': True, 'scorecard': {'processing': {'complete_now': 14301, 'has_error_now': 257}}}
	text = platform_board.render(rows(), '2026-11-05T12:00:00Z', scorecard)
	lines = text.splitlines()
	assert lines[0] == '**Platform** · changed 12:00 UTC · factory 14301 complete, 257 errors'
	assert len(lines) == 1 + len(platform_board.ROWS)
	assert lines[1].startswith('🟢 data2 · ')
	assert 'factory not read' in platform_board.render(rows(), None, {})


# --- Wake rules ---------------------------------------------------------------


def after(previous, built, now=NOON):
	return platform_board.wake(previous, built, now)


def settled(built=None):
	return after({}, built or rows())[2]


def test_first_board_goes_out_once_and_a_quiet_tick_sends_nothing():
	reasons, _, state = after({}, rows())
	assert reasons == ['first board']
	assert state['changed_at'] == '2026-11-05T12:00:00Z'
	reasons, found, next_state = after(state, rows(), NOON + timedelta(minutes=15))
	assert (reasons, found) == ([], [])
	assert next_state['changed_at'] == state['changed_at']


def test_counts_inside_a_colour_stay_quiet():
	state = settled()
	busy = rows(fact=facts(workers=[{'name': 'deepl1', 'dataset_id': 1, 'step': 'cog'}]))
	assert after(state, busy)[0] == []


def test_a_colour_change_wakes_and_moves_the_changed_time():
	state = settled()
	later = NOON + timedelta(minutes=15)
	reasons, _, next_state = after(state, rows(active=tracked('yellow', 'deepl1', 'disk:/')), later)
	assert reasons == ['deepl1 🟢 to 🟡']
	assert next_state['changed_at'] == '2026-11-05T12:15:00Z'
	assert after(next_state, rows(active=tracked('yellow', 'deepl1', 'disk:/')), later)[0] == []


def test_an_issue_link_change_wakes():
	active = tracked('yellow', 'deepl1', 'disk:/')
	state = settled(rows(active=active))
	reasons, _, _ = after(state, rows(active=active, issues={'dt-status/deepl1/disk:/': 'DT-3'}))
	assert reasons == ['deepl1 issue link changed']


def test_one_unread_tick_stays_quiet_and_two_wake():
	state = settled()
	down = rows(snapshot(**{'processing:deepl1': {'ok': False, 'error': 'x'}}))
	reasons, _, held = after(state, down, NOON + timedelta(minutes=15))
	assert reasons == []
	# It recovered: nothing was sent, so nothing needs sending.
	assert after(held, rows(), NOON + timedelta(minutes=30))[0] == []
	reasons, _, _ = after(held, down, NOON + timedelta(minutes=30))
	assert reasons == ['deepl1 🟢 to ⚪']


def test_a_recovery_from_unknown_wakes():
	down = rows(snapshot(**{'processing:deepl1': {'ok': False, 'error': 'x'}}))
	state = settled(down)
	assert after(state, rows())[0] == ['deepl1 ⚪ to 🟢']


def test_a_row_red_on_two_ticks_is_a_finding_once():
	red = rows(active=tracked('red', 'helicon', 'processor', 'helicon exited'), issues={'dt-status/helicon/processor': 'DT-9'})
	state = settled()
	reasons, found, state = after(state, red, NOON + timedelta(minutes=15))
	assert reasons == ['helicon 🟢 to 🔴']
	assert found == []
	reasons, found, state = after(state, red, NOON + timedelta(minutes=30))
	assert reasons == ['helicon red on two ticks']
	assert found == [{'row': 'helicon', 'summary': 'helicon exited', 'issues': ['DT-9']}]
	assert after(state, red, NOON + timedelta(minutes=45))[:2] == ([], [])


def test_an_unread_tick_neither_clears_nor_restarts_the_red_count():
	red = rows(active=tracked('red', 'helicon', 'processor', 'exited'))
	down = rows(snapshot(**{'processing:helicon': {'ok': False, 'error': 'x'}}))
	_, _, state = after(settled(), red)
	_, _, state = after(state, down)
	assert state['red_ticks']['helicon'] == 1
	_, found, _ = after(state, red)
	assert [item['row'] for item in found] == ['helicon']


def test_a_red_that_is_only_main_ci_is_not_reported_again_after_two_ticks():
	red = rows(active=tracked('red', 'deploy', 'ci:migrate', 'main migrate job failure'))
	_, _, state = after(settled(), red)
	reasons, found, _ = after(state, red)
	assert (reasons, found) == ([], [])


def test_first_tick_after_six_berlin_sends_the_board_once_a_day():
	night = datetime(2026, 11, 5, 3, 7, tzinfo=timezone.utc)  # 04:07 Berlin
	morning = datetime(2026, 11, 5, 5, 7, tzinfo=timezone.utc)  # 06:07 Berlin
	_, _, state = after({}, rows(), night)
	assert state['morning'] is None
	reasons, _, state = after(state, rows(), morning)
	assert reasons == ['first tick of the day']
	assert after(state, rows(), morning + timedelta(minutes=15))[0] == []
	reasons, _, _ = after(state, rows(), morning + timedelta(days=1))
	assert reasons == ['first tick of the day']


def test_finding_lines_cover_rows_and_failed_main_jobs():
	item = findings.finding('red', 'deploy', 'ci:migrate', 'main migrate job failure at abc1234: https://x/y')
	lines = platform_board.finding_lines(
		[{'row': 'data2', 'summary': 'API down', 'issues': ['DT-1']}], [item], {item['fingerprint']: 'DT-2'},
	)
	assert lines[0].startswith('- [finding] data2: API down [DT-1](')
	assert lines[1].startswith('- [finding] deploys: main migrate job failure at abc1234')
	assert lines[1].endswith('issue/DT-2)')


# --- Main CI ------------------------------------------------------------------


def test_a_failed_main_job_is_a_red_finding_at_once():
	found, gaps, unobserved = findings.main_ci_findings({
		'migrate': {'conclusion': 'failure', 'headSha': 'abcdef123456', 'url': 'https://github.com/x/y/actions/runs/1'},
		'frontend deploy': {'conclusion': 'success'},
	})
	assert [item['fingerprint'] for item in found] == ['dt-status/deploy/ci:migrate']
	assert found[0]['severity'] == 'red' and 'confirm' not in found[0]
	assert 'abcdef1' in found[0]['summary']
	assert (gaps, unobserved) == ([], [])


def test_a_cancelled_or_missing_main_run_is_not_a_finding():
	assert findings.main_ci_findings({'migrate': {'conclusion': 'cancelled'}, 'frontend deploy': {}})[0] == []


def test_unread_main_ci_is_a_gap_and_keeps_its_earlier_finding():
	found, gaps, unobserved = findings.main_ci_findings(None)
	assert found == []
	assert gaps == ['main CI: not checked']
	assert unobserved == ['dt-status/deploy/ci:*']


# --- Timer --------------------------------------------------------------------


def test_timer_runs_every_15_minutes_by_day_and_every_2_hours_at_night():
	text = (MONITOR / 'systemd' / 'deadtrees-monitor.timer').read_text()
	calendars = re.findall(r'^OnCalendar=(.*)$', text, flags=re.MULTILINE)
	assert calendars == ['*-*-* 06..17:07,22,37,52:00 Europe/Berlin', '*-*-* 00,02,04,18,20,22:07:00 Europe/Berlin']


# --- The thread's wait --------------------------------------------------------


def write_tick(state_dir, at):
	(state_dir / board_wait.TICK_STATE).write_text(json.dumps({'last_tick_at': at}))


def test_wait_reports_notes_and_the_reconcile_until_it_is_done(tmp_path):
	write_tick(tmp_path, '2026-11-05T11:52:00Z')
	(tmp_path / board_wait.OUTBOX).mkdir()
	assert board_wait.pending(tmp_path, NOON) == {'notes': [], 'reconcile_due': True}
	board_wait.reconciled(tmp_path, NOON)
	assert board_wait.pending(tmp_path, NOON + timedelta(minutes=1)) == {'notes': [], 'reconcile_due': False}
	note = tmp_path / board_wait.OUTBOX / '20261105T120000Z.md'
	note.write_text('x')
	assert board_wait.pending(tmp_path, NOON + timedelta(minutes=2))['notes'] == [str(note)]


def test_reconcile_is_due_again_after_115_minutes(tmp_path):
	write_tick(tmp_path, '2026-11-05T13:52:00Z')
	(tmp_path / board_wait.OUTBOX).mkdir()
	board_wait.reconciled(tmp_path, NOON)
	assert board_wait.pending(tmp_path, NOON + timedelta(minutes=114))['reconcile_due'] is False
	assert board_wait.pending(tmp_path, NOON + timedelta(minutes=115))['reconcile_due'] is True


def test_a_stalled_monitor_leaves_one_note_per_stalled_tick(tmp_path):
	write_tick(tmp_path, '2026-11-05T11:00:00Z')
	found = board_wait.pending(tmp_path, NOON)
	assert len(found['notes']) == 1
	text = Path(found['notes'][0]).read_text()
	assert 'stalled' in text and '2026-11-05T11:00:00Z' in text and '60 min ago' in text
	Path(found['notes'][0]).unlink()
	assert board_wait.pending(tmp_path, NOON + timedelta(minutes=5))['notes'] == []
	# A new tick that stalls again is a new note.
	write_tick(tmp_path, '2026-11-05T12:30:00Z')
	assert len(board_wait.pending(tmp_path, NOON + timedelta(hours=2))['notes']) == 1


def test_the_night_allows_two_slots_before_it_calls_a_stall(tmp_path):
	night = datetime(2026, 11, 5, 21, 0, tzinfo=timezone.utc)  # 22:00 Berlin
	write_tick(tmp_path, '2026-11-05T19:07:00Z')
	(tmp_path / board_wait.OUTBOX).mkdir()
	assert board_wait.pending(tmp_path, night)['notes'] == []
	assert len(board_wait.pending(tmp_path, night + timedelta(minutes=40))['notes']) == 1
