"""Audit worker: queue order, the run lifecycle, pausing on logins and limits, model backends."""

import io
import json
import queue
import subprocess
import time
from types import SimpleNamespace

import pytest
from PIL import Image

from processor.src.audit_worker import models, runs, worker


class Query:
	"""The few PostgREST builder calls the worker uses, over in-memory rows."""

	def __init__(self, table, action='select', payload=None):
		self.table, self.action, self.payload, self.filters, self.orders, self.cap, self.one = (
			table,
			action,
			payload,
			[],
			[],
			None,
			False,
		)

	def select(self, *_):
		return self

	def eq(self, key, value):
		self.filters.append(lambda r: r.get(key) == value)
		return self

	def in_(self, key, values):
		self.filters.append(lambda r: r.get(key) in values)
		return self

	def gte(self, key, value):
		self.filters.append(lambda r: r.get(key) is not None and r.get(key) >= value)
		return self

	def gt(self, key, value):
		self.filters.append(lambda r: r.get(key) is not None and r.get(key) > value)
		return self

	def lt(self, key, value):
		self.filters.append(lambda r: r.get(key) is not None and r.get(key) < value)
		return self

	def order(self, key):
		self.orders.append(key)
		return self

	def limit(self, n):
		self.cap = n
		return self

	def single(self):
		self.one = True
		return self

	def matching(self):
		return [r for r in self.table.rows if all(f(r) for f in self.filters)]

	def execute(self):
		if self.action == 'insert':
			rows = self.payload if isinstance(self.payload, list) else [self.payload]
			added = [self.table.add(dict(r)) for r in rows]
			return SimpleNamespace(data=added)
		if self.action == 'upsert':
			key = self.table.conflict
			existing = [r for r in self.table.rows if all(r.get(k) == self.payload.get(k) for k in key)]
			if existing:
				existing[0].update(self.payload)
				return SimpleNamespace(data=existing)
			return SimpleNamespace(data=[self.table.add(dict(self.payload))])
		rows = self.matching()
		if self.action == 'update':
			for r in rows:
				r.update(self.payload)
			return SimpleNamespace(data=[dict(r) for r in rows])
		for key in reversed(self.orders):
			rows = sorted(rows, key=lambda r: r.get(key))
		rows = [dict(r) for r in rows[: self.cap]]
		return SimpleNamespace(data=rows[0] if self.one else rows)


class Table:
	def __init__(self, conflict=()):
		self.rows, self.next_id, self.conflict = [], 1, conflict

	def add(self, row):
		row.setdefault('id', self.next_id)
		self.next_id += 1
		self.rows.append(row)
		return dict(row)

	def select(self, *_):
		return Query(self)

	def update(self, payload):
		return Query(self, 'update', payload)

	def insert(self, payload):
		return Query(self, 'insert', payload)

	def upsert(self, payload, on_conflict=''):
		self.conflict = tuple(on_conflict.split(','))
		return Query(self, 'upsert', payload)


class Client:
	def __init__(self):
		self.tables = {'check_versions': Table(), 'runs': Table(), 'current_runs': Table(), 'v2_statuses': Table()}

	def schema(self, name):
		assert name == 'audit'
		return self

	def table(self, name):
		return self.tables[name]


def version(client, check='prediction_quality', name='v1', active=True, **config):
	return client.tables['check_versions'].add(
		{
			'check_key': check,
			'version': name,
			'is_active': active,
			'mode': 'review_all',
			'config': {'models': {}, **config},
		}
	)


def queued(client, version_row, dataset, queue='upload', created='2026-11-02T08:00', **extra):
	return client.tables['runs'].add(
		{
			'check_key': version_row['check_key'],
			'check_version_id': version_row['id'],
			'dataset_id': dataset,
			'queue': queue,
			'status': 'queued',
			'attempts': 0,
			'created_at': created,
			**extra,
		}
	)


def handler(result=None, error=None, recompute=None):
	calls = []

	def handle(ctx):
		calls.append(('handle', ctx.run['id'], sorted(ctx.judges)))
		if error:
			raise error
		return result or {}

	module = SimpleNamespace(VERSION='v1', CONFIG={'models': {}}, handle=handle, calls=calls)
	if recompute:
		module.recompute = lambda ctx: calls.append(('recompute', ctx.run['id'], sorted(ctx.judges))) or recompute
	return module


def run_row(client, run_id):
	return next(r for r in client.tables['runs'].rows if r['id'] == run_id)


@pytest.mark.unit
def test_new_uploads_go_before_manual_runs_and_the_backfill():
	client = Client()
	v = version(client)
	backfill = queued(client, v, 1, 'backfill', created='2026-11-01T00:00')
	manual = queued(client, v, 2, 'manual', created='2026-11-02T09:00')
	upload = queued(client, v, 3, 'upload', created='2026-11-02T10:00')
	queued(client, v, 4, 'benchmark')
	order = [runs.claim_next(client, ['prediction_quality'])['id'] for _ in range(3)]
	assert order == [upload['id'], manual['id'], backfill['id']]
	assert runs.claim_next(client, ['prediction_quality']) is None  # benchmark runs only in a benchmark session
	assert runs.claim_next(client, ['prediction_quality'], benchmark=True)['dataset_id'] == 4
	assert run_row(client, upload['id'])['status'] == 'running' and run_row(client, upload['id'])['attempts'] == 1


@pytest.mark.unit
def test_a_finished_run_of_the_active_version_becomes_current():
	client = Client()
	active, candidate = version(client), version(client, name='v2', active=False)
	first, second = queued(client, active, 1), queued(client, candidate, 2, 'manual')
	h = handler(result={'coverage': {'crops': 10}})
	assert worker.tick(client=client, handlers={'prediction_quality': h}, put_image=None) == 'done'
	assert worker.tick(client=client, handlers={'prediction_quality': h}, put_image=None) == 'done'
	assert run_row(client, first['id'])['status'] == 'done' and run_row(client, first['id'])['coverage'] == {
		'crops': 10
	}
	# only the active version's result counts for its dataset
	assert [(r['dataset_id'], r['run_id']) for r in client.tables['current_runs'].rows] == [(1, first['id'])]
	assert run_row(client, second['id'])['status'] == 'done'


@pytest.mark.unit
@pytest.mark.parametrize(
	('error', 'retry'),
	[
		(models.LoginExpired('claude', 'Please run /login'), worker.LOGIN_PROBE_SECONDS),
		(models.LimitReached('codex', 'usage limit reached'), worker.LIMIT_PAUSE_SECONDS),
	],
)
def test_an_expired_login_or_a_usage_limit_pauses_without_spending_an_attempt(error, retry, tmp_path, monkeypatch):
	monkeypatch.setattr(worker, 'STATUS_FILE', tmp_path / 'status.json')
	client = Client()
	run = queued(client, version(client), 1)
	sleeps = []
	status = worker.run_forever(
		connect=lambda: (client, 'token'),
		handlers={'prediction_quality': handler(error=error)},
		put_image=None,
		once=True,
		sleep=sleeps.append,
	)
	assert status['state'] == 'paused' and status['transport'] == error.transport
	assert run_row(client, run['id'])['status'] == 'queued' and run_row(client, run['id'])['attempts'] == 0
	assert json.loads((tmp_path / 'status.json').read_text())['reason'] == str(error)
	assert abs(status['retry_at'] - time.time() - retry) < 60
	# while paused and the login is still gone, the worker only waits
	monkeypatch.setattr(models, 'logged_in', lambda transport: False)
	again = worker.run_forever(
		connect=lambda: (client, 'token'),
		handlers={'prediction_quality': handler()},
		put_image=None,
		once=True,
		sleep=sleeps.append,
	)
	assert again['state'] == 'paused' and sleeps == [worker.LOGIN_PROBE_SECONDS]
	assert run_row(client, run['id'])['status'] == 'queued'


@pytest.mark.unit
def test_other_errors_are_retried_then_the_run_fails_with_its_error():
	client = Client()
	run = queued(client, version(client), 1)
	h = handler(error=ValueError('bad answer'))
	results = [
		worker.tick(client=client, handlers={'prediction_quality': h}, put_image=None) for _ in range(runs.MAX_ATTEMPTS)
	]
	assert results == ['queued'] * (runs.MAX_ATTEMPTS - 1) + ['failed']
	row = run_row(client, run['id'])
	assert row['status'] == 'failed' and row['error'] == 'ValueError: bad answer' and row['finished_at']
	assert client.tables['current_runs'].rows == []


@pytest.mark.unit
def test_a_rule_only_run_recomputes_without_judges():
	client = Client()
	v1 = version(client, active=False, models={'haiku-5.5': {'transport': 'claude', 'model': 'claude-haiku-5-5'}})
	source = queued(client, v1, 1)
	client.tables['runs'].rows[-1]['status'] = 'done'
	v2 = version(client, name='v2', models={'haiku-5.5': {'transport': 'claude', 'model': 'claude-haiku-5-5'}})
	rerun = queued(client, v2, 1, source_run_id=source['id'])
	h = handler(recompute={'evidence': {'rule': 'pq-dataset-rule/v2'}})
	assert worker.tick(client=client, handlers={'prediction_quality': h}, put_image=None) == 'done'
	assert h.calls == [('recompute', rerun['id'], [])]
	assert run_row(client, rerun['id'])['evidence'] == {'rule': 'pq-dataset-rule/v2'}
	# a check that cannot recompute is not handed a rule-only run as a normal one
	other = queued(client, v2, 2, source_run_id=source['id'])
	assert worker.tick(client=client, handlers={'prediction_quality': handler()}, put_image=None) == 'queued'
	assert 'cannot recompute' in run_row(client, other['id'])['error']


@pytest.mark.unit
def test_finished_datasets_are_queued_once_per_version():
	client = Client()
	v = version(client)
	statuses = client.tables['v2_statuses']
	for dataset, done in ((1, True), (2, True), (3, False)):
		statuses.add(
			{
				'dataset_id': dataset,
				'updated_at': '2026-11-02T09:00',
				'current_status': 'idle',
				'has_error': False,
				'is_cog_done': True,
				'is_combined_model_done': done,
			}
		)
	queued(client, v, 2, 'backfill')  # already has a run of this version
	h = handler()
	assert worker.enqueue_ready(client, {'prediction_quality': h}, '2026-11-02T08:00', '2026-11-02T10:00') == {
		'prediction_quality': 1
	}
	assert sorted((r['dataset_id'], r['queue']) for r in client.tables['runs'].rows) == [(1, 'upload'), (2, 'backfill')]
	assert worker.enqueue_ready(client, {'prediction_quality': h}, '2026-11-02T08:00', '2026-11-02T10:00') == {
		'prediction_quality': 0
	}


@pytest.mark.unit
def test_every_finished_dataset_is_queued_however_many_pages_and_shared_timestamps(monkeypatch):
	monkeypatch.setattr(runs, 'PAGE', 3)
	client = Client()
	version(client)
	# seven datasets, five of them finished in the same second, more than two pages
	times = ['2026-11-02T09:00'] * 5 + ['2026-11-02T09:01', '2026-11-02T09:02']
	for dataset, at in zip((14, 3, 9, 1, 22, 5, 8), times):
		client.tables['v2_statuses'].add(
			{
				'dataset_id': dataset,
				'updated_at': at,
				'current_status': 'idle',
				'has_error': False,
				'is_cog_done': True,
				'is_combined_model_done': True,
			}
		)
	marks = []
	added = worker.enqueue_ready(
		client, {'prediction_quality': handler()}, '2026-11-02T08:00', '2026-11-02T10:00', done=marks.append
	)
	assert added == {'prediction_quality': 7}
	assert sorted(r['dataset_id'] for r in client.tables['runs'].rows) == [1, 3, 5, 8, 9, 14, 22]
	assert marks == ['2026-11-02T09:00', '2026-11-02T09:01', '2026-11-02T09:02']


@pytest.mark.unit
def test_datasets_finished_while_the_worker_was_down_are_still_queued(tmp_path, monkeypatch):
	monkeypatch.setattr(worker, 'STATUS_FILE', tmp_path / 'status.json')
	client = Client()
	version(client)
	# the worker last queued at 06:00, then stopped for hours
	worker.write_watermark('2026-11-02T06:00:00+00:00')
	client.tables['v2_statuses'].add(
		{
			'dataset_id': 7,
			'updated_at': '2026-11-02T07:30:00+00:00',
			'current_status': 'idle',
			'has_error': False,
			'is_cog_done': True,
			'is_combined_model_done': True,
		}
	)
	worker.run_forever(
		connect=lambda: (client, 'token'),
		handlers={'prediction_quality': handler()},
		put_image=None,
		once=True,
		sleep=lambda s: None,
	)
	assert [r['dataset_id'] for r in client.tables['runs'].rows] == [7]
	assert worker.read_watermark() > '2026-11-02T07:30:00+00:00'


@pytest.mark.unit
def test_the_worker_needs_a_memory_cap_of_its_cgroup(tmp_path):
	root = tmp_path / 'cgroup'
	scope = root / 'user.slice' / 'run-1.scope'
	scope.mkdir(parents=True)
	(root / 'user.slice' / 'memory.max').write_text('max\n')
	(scope / 'memory.max').write_text(f'{8 * 1024**3}\n')
	proc = tmp_path / 'proc-cgroup'
	proc.write_text('0::/user.slice/run-1.scope\n')
	assert worker.memory_limit(root, proc) == 8 * 1024**3
	(scope / 'memory.max').write_text('max\n')
	assert worker.memory_limit(root, proc) is None


def claude_events(result, is_error=False, tools=()):
	lines = [
		{'type': 'system', 'subtype': 'init', 'tools': list(tools)},
		{'type': 'result', 'result': result, 'is_error': is_error},
	]
	return '\n'.join(json.dumps(line) for line in lines) + '\n'


@pytest.mark.unit
def test_claude_backend_sends_the_images_inline_without_any_tool_and_maps_login_problems():
	seen = {}

	def fake_run(command, input, **kwargs):
		seen['command'], seen['message'] = command, json.loads(input)
		return subprocess.CompletedProcess(command, 0, claude_events('{"ok": true}'), '')

	ask = models.claude_backend('claude-haiku-5-5', run=fake_run)
	assert ask('judge', [Image.new('RGB', (8, 8)), Image.new('RGB', (8, 8))]) == '{"ok": true}'
	content = seen['message']['message']['content']
	assert [c['type'] for c in content] == ['text', 'image', 'text', 'image', 'text']
	command = seen['command']
	# no tool at all, so a model can never read the worker's files
	assert command[command.index('--tools') + 1] == '' and '--strict-mcp-config' in command
	assert command[command.index('--input-format') + 1] == 'stream-json'

	def offered_tools(command, **kwargs):
		return subprocess.CompletedProcess(command, 0, claude_events('{}', tools=['Read']), '')

	with pytest.raises(models.ModelError, match='tools were offered'):
		models.claude_backend('claude-haiku-5-5', run=offered_tools)('judge', [])

	for reply, error in (
		('Invalid API key · Please run /login', models.LoginExpired),
		('Claude usage limit reached', models.LimitReached),
	):

		def failing(command, reply=reply, **kwargs):
			return subprocess.CompletedProcess(command, 1, claude_events(reply, is_error=True), '')

		with pytest.raises(error):
			models.claude_backend('claude-haiku-5-5', run=failing)('judge', [Image.new('RGB', (8, 8))])


@pytest.mark.unit
def test_a_run_left_running_by_a_stopped_worker_goes_back_to_the_queue():
	client = Client()
	v = version(client)
	stranded = queued(client, v, 1)
	runs.claim_next(client, ['prediction_quality'])
	last = queued(client, v, 2, attempts=runs.MAX_ATTEMPTS, status='running')
	assert runs.recover(client, ['prediction_quality']) == 2
	assert (
		run_row(client, stranded['id'])['status'] == 'queued'
		and 'interrupted' in run_row(client, stranded['id'])['error']
	)
	assert run_row(client, last['id'])['status'] == 'failed'


def pointer(client, dataset):
	return next((r['run_id'] for r in client.tables['current_runs'].rows if r['dataset_id'] == dataset), None)


@pytest.mark.unit
def test_the_sweep_points_datasets_at_their_newest_finished_run():
	client = Client()
	v = version(client)
	older = queued(client, v, 1, status='done', finished_at='2026-11-02T08:00')
	newer = queued(client, v, 1, status='done', finished_at='2026-11-02T09:00')
	unpointed = queued(client, v, 2, status='done', finished_at='2026-11-02T09:00')
	queued(client, v, 3, 'benchmark', status='done', finished_at='2026-11-02T09:00')
	runs.point(client, older)  # the pointer to the newer run never landed
	assert worker.sweep(client, {'prediction_quality': handler()}, '2026-11-01T00:00') == 2
	assert (pointer(client, 1), pointer(client, 2), pointer(client, 3)) == (newer['id'], unpointed['id'], None)
	assert worker.sweep(client, {'prediction_quality': handler()}, '2026-11-01T00:00') == 0


@pytest.mark.unit
def test_an_older_backfill_finishing_after_a_newer_upload_leaves_the_pointer():
	client = Client()
	v = version(client)
	backfill = queued(client, v, 1, 'backfill', created='2026-11-01T00:00')
	upload = queued(client, v, 1, 'upload', created='2026-11-02T09:00')
	h = {'prediction_quality': handler()}
	assert worker.tick(client=client, handlers=h, put_image=None) == 'done'  # the upload goes first
	assert worker.tick(client=client, handlers=h, put_image=None) == 'done'
	assert run_row(client, backfill['id'])['status'] == 'done'
	assert pointer(client, 1) == upload['id']
	assert worker.sweep(client, h, '2026-11-01T00:00') == 0 and pointer(client, 1) == upload['id']


@pytest.mark.unit
def test_promotion_moves_pointers_from_the_old_version_whatever_the_ids():
	client = Client()
	old = version(client)
	candidate = version(client, name='v2', active=False)
	shadow = queued(client, candidate, 1, 'manual')  # the candidate ran first: lower id
	current = queued(client, old, 1)
	h = {'prediction_quality': handler()}
	worker.tick(client=client, handlers=h, put_image=None)
	worker.tick(client=client, handlers=h, put_image=None)
	# a run of an inactive version never moves the pointer
	assert pointer(client, 1) == current['id']
	assert worker.sweep(client, h, '2026-11-01T00:00') == 0
	# the operator activates the candidate; the sweep promotes its earlier run
	for row in client.tables['check_versions'].rows:
		row['is_active'] = row['id'] == candidate['id']
	assert shadow['id'] < current['id']
	assert worker.sweep(client, h, '2026-11-01T00:00') == 1 and pointer(client, 1) == shadow['id']


@pytest.mark.unit
def test_a_pointer_moved_by_someone_else_meanwhile_is_decided_again():
	client = Client()
	v = version(client)
	first, second, third = (queued(client, v, 1, status='done') for _ in range(3))
	runs.point(client, first)
	original_update = client.tables['current_runs'].update

	def racing_update(payload):
		# another writer points at the third run between our read and our write
		client.tables['current_runs'].rows[0]['run_id'] = third['id']
		client.tables['current_runs'].update = original_update
		return original_update(payload)

	client.tables['current_runs'].update = racing_update
	assert runs.point(client, second) is False
	assert pointer(client, 1) == third['id']


@pytest.mark.unit
def test_new_evidence_gets_a_new_run_and_benchmarks_are_scheduled_apart():
	client = Client()
	v = version(client)
	first = {'ortho_sha256': 'a' * 64, 'label_ids': {'deadwood': 1}}
	queued(client, v, 1, inputs=first)
	queued(client, v, 2, 'benchmark', inputs={})
	assert runs.enqueue(client, v, [1], 'upload', inputs={1: first}) == []
	# predictions were rerun: same version, new labels, new run
	assert runs.enqueue(client, v, [1], 'upload', inputs={1: {**first, 'label_ids': {'deadwood': 2}}}) == [1]
	# a benchmark run does not stand in for a production one
	assert runs.enqueue(client, v, [2], 'backfill') == [2]
	assert runs.enqueue(client, v, [2], 'manual') == []
	assert runs.enqueue(client, v, [2], 'manual', force=True) == [2]


class FakeAppServer:
	"""Plays the Codex app-server side of one turn."""

	def __init__(self, answer='{"ok": true}', turn_error=None, served=None):
		self.answer, self.turn_error, self.served, self.sent = answer, turn_error, served, []
		self.stdin = SimpleNamespace(write=self.receive, flush=lambda: None)
		self.lines = queue.Queue()
		self.stdout = iter(self.lines.get, None)  # blocks like a pipe until a line arrives
		self.stderr = io.StringIO('')

	def receive(self, line):
		message = json.loads(line)
		self.sent.append(message)
		reply = {
			'initialize': {},
			'thread/start': {'model': self.served or message.get('params', {}).get('model'), 'thread': {'id': 't1'}},
			'turn/start': {},
		}.get(message.get('method'))
		if 'id' in message and reply is not None:
			self.lines.put(json.dumps({'id': message['id'], 'result': reply}) + '\n')
		if message.get('method') == 'turn/start':
			if self.turn_error:
				self.lines.put(
					json.dumps(
						{'method': 'turn/completed', 'params': {'turn': {'status': 'failed', 'error': self.turn_error}}}
					)
					+ '\n'
				)
			else:
				self.lines.put(
					json.dumps(
						{'method': 'item/completed', 'params': {'item': {'type': 'agentMessage', 'text': self.answer}}}
					)
					+ '\n'
				)
				self.lines.put(
					json.dumps({'method': 'turn/completed', 'params': {'turn': {'status': 'completed'}}}) + '\n'
				)

	def terminate(self):
		pass

	def wait(self, timeout=None):
		return 0


def codex_with(server):
	def popen(command, **kwargs):
		server.command = command
		return server

	return models.codex_backend('gpt-6-luna', 'medium', popen=popen)


@pytest.mark.unit
def test_codex_backend_sends_the_images_and_maps_limits():
	server = FakeAppServer()
	assert codex_with(server)('judge', [Image.new('RGB', (8, 8))]) == '{"ok": true}'
	turn = next(m for m in server.sent if m.get('method') == 'turn/start')
	assert [i['type'] for i in turn['params']['input']] == ['text', 'text', 'image']
	start = next(m for m in server.sent if m.get('method') == 'thread/start')['params']
	assert (
		start['sandbox'] == 'read-only' and start['dynamicTools'] == [] and start['allowProviderModelFallback'] is False
	)
	with pytest.raises(models.LimitReached):
		codex_with(FakeAppServer(turn_error={'message': 'You have hit your usage limit'}))('judge', [])
	with pytest.raises(models.ModelError, match='served'):
		codex_with(FakeAppServer(served='gpt-6.1-sol'))('judge', [])


@pytest.mark.unit
def test_judges_come_from_the_version_config():
	built = models.judges(
		{
			'haiku-5.5': {'transport': 'claude', 'model': 'claude-haiku-5-5'},
			'luna-medium': {'transport': 'codex', 'model': 'gpt-6-luna', 'effort': 'medium'},
		}
	)
	assert sorted(built) == ['haiku-5.5', 'luna-medium'] and all(callable(b) for b in built.values())
