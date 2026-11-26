"""Audit worker: queue order, the run lifecycle, pausing on logins and limits, model backends."""

import io
import json
import queue
import subprocess
import threading
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

	def neq(self, key, value):
		self.filters.append(lambda r: r.get(key) != value)
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
		self.tables = {'check_versions': Table(), 'check_rules': Table(), 'runs': Table(), 'v2_statuses': Table()}
		self.finished, self.finish_error = [], None

	def schema(self, name):
		assert name == 'audit'
		return self

	def table(self, name):
		return self.tables[name]

	def rpc(self, name, args):
		"""audit.finish_run: the run's rows and its end state in one transaction."""
		assert name == 'finish_run'

		def execute():
			if self.finish_error:
				raise self.finish_error
			run = next(r for r in self.tables['runs'].rows if r['id'] == args['p_run_id'])
			assert run['status'] == 'running'
			self.finished.append(args)
			result = args['p_result']
			run.update(status='done', finished_at=runs.now(), inputs=result.get('inputs', run.get('inputs')))
			run['evidence'] = result.get('evidence', {})
			return SimpleNamespace(data=None)

		return SimpleNamespace(execute=execute)


def version(client, check='prediction_quality', name='v1', active=True, **config):
	return client.tables['check_versions'].add(
		{'check_key': check, 'version': name, 'is_active': active, 'config': {'models': {}, **config}}
	)


def queued(client, version_row, dataset, queue='upload', created='2026-11-02T08:00', **extra):
	return client.tables['runs'].add(
		{
			'version_id': version_row['id'],
			'dataset_id': dataset,
			'queue': queue,
			'status': 'queued',
			'attempts': 0,
			'created_at': created,
			**extra,
		}
	)


def handler(result=None, error=None):
	calls = []

	def handle(ctx):
		calls.append(('handle', ctx.run['id'], sorted(ctx.judges)))
		if error:
			raise error
		return result or {}

	return SimpleNamespace(
		VERSION='v1',
		CONFIG={'models': {}},
		RULES='rules-v1',
		RULES_CONFIG={'decider': 'haiku'},
		handle=handle,
		calls=calls,
	)


def run_row(client, run_id):
	return next(r for r in client.tables['runs'].rows if r['id'] == run_id)


@pytest.mark.unit
def test_new_uploads_go_before_manual_runs_and_the_backfill():
	client = Client()
	v = version(client)
	backfill = queued(client, v, 1, 'backfill', created='2026-11-01T00:00')
	manual = queued(client, v, 2, 'manual', created='2026-11-02T09:00')
	upload = queued(client, v, 3, 'upload', created='2026-11-02T10:00')
	other = version(client, check='dataset_evaluation')
	queued(client, other, 4, 'upload', created='2026-11-01T00:00')
	order = [runs.claim_next(client, [v['id']])['id'] for _ in range(3)]
	assert order == [upload['id'], manual['id'], backfill['id']]
	assert runs.claim_next(client, [v['id']]) is None  # another check's run is not this worker's
	assert run_row(client, upload['id'])['status'] == 'running' and run_row(client, upload['id'])['attempts'] == 1


@pytest.mark.unit
def test_a_run_of_any_version_is_finished_through_finish_run():
	"""Which run counts is the database's view (audit.current_runs); the worker points nothing."""
	client = Client()
	active, candidate = version(client), version(client, name='v2', active=False)
	first, second = queued(client, active, 1), queued(client, candidate, 2, 'manual')
	result = {'inputs': {'ortho_sha256': 'a'}, 'evidence': {'coverage': {'tiles': 10}}, 'tiles': [], 'images': []}
	h = handler(result=result)
	assert worker.tick(client=client, handlers={'prediction_quality': h}, put_image=None) == 'done'
	assert worker.tick(client=client, handlers={'prediction_quality': h}, put_image=None) == 'done'
	assert [args['p_run_id'] for args in client.finished] == [first['id'], second['id']]
	assert client.finished[0]['p_result'] == result
	assert run_row(client, first['id'])['status'] == 'done' and run_row(client, second['id'])['status'] == 'done'


@pytest.mark.unit
def test_a_run_whose_rows_cannot_be_stored_counts_as_an_attempt():
	client = Client()
	run = queued(client, version(client), 1)
	client.finish_error = RuntimeError('tile_index 3 out of range')
	assert worker.tick(client=client, handlers={'prediction_quality': handler()}, put_image=None) == 'queued'
	row = run_row(client, run['id'])
	assert row['status'] == 'queued' and row['attempts'] == 1 and 'tile_index 3' in row['error']


@pytest.mark.unit
def test_the_worker_registers_each_version_with_its_rules_once():
	client = Client()
	handlers = {'prediction_quality': handler()}
	registered = worker.register(client, handlers)
	worker.register(client, handlers)
	(row,) = client.tables['check_versions'].rows
	assert registered['prediction_quality']['id'] == row['id'] and 'is_active' not in row  # inactive by default
	(rules,) = client.tables['check_rules'].rows
	assert (rules['version_id'], rules['name'], rules['config']) == (row['id'], 'rules-v1', {'decider': 'haiku'})


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
@pytest.mark.parametrize('error', [None, RuntimeError('boom'), models.LimitReached('codex', 'usage limit reached')])
def test_the_login_is_renewed_before_a_run_is_written_to_its_end_state(error):
	"""The login a run starts with lasts 20 to 60 minutes, and a run's model calls can take that long."""
	client = Client()
	run = queued(client, version(client), 1)
	seen = []

	def refresh(renewed):
		seen.append((renewed is client, run_row(client, run['id'])['status']))

	def handle(ctx):
		ctx.refresh()  # a handler renews before its own uploads
		if error:
			raise error
		return {}

	h = SimpleNamespace(VERSION='v1', CONFIG={'models': {}}, handle=handle)
	try:
		worker.tick(client=client, handlers={'prediction_quality': h}, put_image=None, refresh=refresh)
	except worker.Paused:
		pass
	# once from the handler, once by the worker before finish_run or the retry, both while the run is running
	assert seen == [(True, 'running')] * 2
	assert run_row(client, run['id'])['status'] in ('done', 'queued')


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
	assert client.finished == []


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
def test_a_stuck_run_fails_and_stops_the_worker(tmp_path, monkeypatch):
	"""A run still going past the deadline fails at once and the worker exits for its service to
	start it again: a thread stuck in a C call cannot be stopped from inside (DT-1619)."""
	monkeypatch.setattr(worker, 'STATUS_FILE', tmp_path / 'status.json')
	client = Client()
	v = version(client)
	queued(client, v, 1)
	run = runs.claim_next(client, [v['id']])
	stopped, codes = threading.Event(), []
	with worker.deadline(run, client, seconds=0.05, stop=lambda code: (codes.append(code), stopped.set())):
		assert stopped.wait(5)
	row = run_row(client, run['id'])
	assert row['status'] == 'failed' and row['error'].startswith('timed out') and codes == [worker.TIMEOUT_EXIT]
	assert worker.read_status()['state'] == 'stopped'


@pytest.mark.unit
def test_a_run_that_ends_in_time_is_left_alone():
	client = Client()
	v = version(client)
	queued(client, v, 1)
	run = runs.claim_next(client, [v['id']])
	codes = []
	with worker.deadline(run, client, seconds=0.1, stop=codes.append):
		pass
	time.sleep(0.2)
	assert codes == [] and run_row(client, run['id'])['status'] == 'running'


@pytest.mark.unit
def test_a_run_left_running_by_a_stopped_worker_goes_back_to_the_queue():
	client = Client()
	v = version(client)
	stranded = queued(client, v, 1)
	runs.claim_next(client, [v['id']])
	last = queued(client, v, 2, attempts=runs.MAX_ATTEMPTS, status='running')
	assert runs.recover(client, [v['id']]) == 2
	assert (
		run_row(client, stranded['id'])['status'] == 'queued'
		and 'interrupted' in run_row(client, stranded['id'])['error']
	)
	assert run_row(client, last['id'])['status'] == 'failed'


@pytest.mark.unit
def test_a_dataset_is_queued_again_when_the_latest_run_of_the_version_judged_other_inputs():
	client = Client()
	v = version(client)
	first = {'ortho_sha256': 'a' * 64, 'label_ids': {'deadwood': 1}}
	rerun = {**first, 'label_ids': {'deadwood': 2}}
	queued(client, v, 1, inputs=first)
	assert runs.enqueue(client, v, [1], 'upload', inputs={1: first}) == []
	# predictions were rerun: same version, new labels, new run
	assert runs.enqueue(client, v, [1], 'upload', inputs={1: rerun}) == [1]
	assert runs.enqueue(client, v, [1], 'upload', inputs={1: rerun}) == []
	# back to the first inputs: the latest run judged others, so it is judged again
	assert runs.enqueue(client, v, [1], 'upload', inputs={1: first}) == [1]
	# another version's run does not stand in, and force always queues
	assert runs.enqueue(client, version(client, name='v2'), [1], 'backfill', inputs={1: first}) == [1]
	assert runs.enqueue(client, v, [1], 'manual', inputs={1: first}, force=True) == [1]


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


@pytest.mark.unit
def test_a_rate_limited_call_waits_and_is_asked_again_before_the_worker_pauses():
	rate = models.LimitReached('codex', 'exceeded retry limit, last status: 429 Too Many Requests')
	replies, waits = [rate, rate, '{"ok": true}'], []

	def backend(prompt, images):
		reply = replies.pop(0)
		if isinstance(reply, Exception):
			raise reply
		return reply

	assert models.paced('claude', backend, sleep=waits.append)('judge', []) == '{"ok": true}'
	assert waits == list(models.RATE_WAITS[:2])
	# a rate limit that outlasts the waits reaches the worker, which pauses
	replies[:] = [rate] * (len(models.RATE_WAITS) + 1)
	with pytest.raises(models.LimitReached):
		models.paced('claude', backend, sleep=waits.append)('judge', [])
	assert replies == []
	# a usage limit is not waited out, and other errors pass through
	for error in (
		models.LimitReached('codex', 'You have hit your usage limit'),
		models.ModelError('codex: no final answer'),
	):
		replies[:], waits[:] = [error, 'never asked'], []
		with pytest.raises(type(error)):
			models.paced('codex', backend, sleep=waits.append)('judge', [])
		assert replies == ['never asked'] and waits == []


@pytest.mark.unit
def test_one_call_at_a_time_on_the_codex_login():
	import threading

	running, most, lock = [0], [0], threading.Lock()

	def backend(prompt, images):
		with lock:
			running[0] += 1
			most[0] = max(most[0], running[0])
		time.sleep(0.02)
		with lock:
			running[0] -= 1
		return 'ok'

	for transport, expected in (('codex', 1), ('claude', 4)):
		most[0] = 0
		ask = models.paced(transport, backend)
		threads = [threading.Thread(target=ask, args=('judge', [])) for _ in range(4)]
		for t in threads:
			t.start()
		for t in threads:
			t.join()
		assert most[0] == expected


@pytest.mark.unit
def test_a_run_records_the_inputs_its_handler_read_again():
	"""The AOI can change between queueing and running: the run then says what it judged."""
	client = Client()
	run = queued(client, version(client), 1, inputs={'ortho_sha256': 'a' * 64, 'aoi': 'old-aoi'})
	judged = {'ortho_sha256': 'a' * 64, 'aoi': 'new-aoi'}
	h = handler(result={'inputs': judged, 'evidence': {}})
	assert worker.tick(client=client, handlers={'prediction_quality': h}, put_image=None) == 'done'
	assert run_row(client, run['id'])['inputs'] == judged


@pytest.mark.unit
def test_a_dataset_whose_inputs_cannot_be_read_is_left_out_without_stopping_the_worker(caplog):
	"""One dataset without an ortho hash must not end the loop or block the ones after it."""

	def inputs(client, dataset_id):
		if dataset_id == 2:
			raise ValueError('dataset has no ortho with a sha256')
		return {'ortho_sha256': f'sha-{dataset_id}'}

	ids, read = worker.judged_inputs(SimpleNamespace(inputs=inputs), None, [1, 2, 3])

	assert ids == [1, 3] and read == {1: {'ortho_sha256': 'sha-1'}, 3: {'ortho_sha256': 'sha-3'}}
	assert 'leaves dataset 2 out' in caplog.text
	# a check without inputs keeps every dataset
	assert worker.judged_inputs(SimpleNamespace(), None, [1, 2]) == ([1, 2], None)
