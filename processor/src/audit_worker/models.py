"""Model backends on the subscription logins.

A backend is a function (prompt, images) -> answer text, the shape the checks' judges use
(prediction_quality_v1.judge.Backend). Each call runs in an empty temporary folder with no
project instructions, settings, plugins or tools: the images travel inline in the request,
so a model can never read files of the worker's account. A login
problem raises LoginExpired and a usage limit LimitReached, so the worker pauses instead of
failing the run; any other problem raises ModelError.
"""

from __future__ import annotations

import base64
import io
import json
import os
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable, Sequence

CALL_SECONDS = 600
LOGIN_PATTERN = re.compile(
	r'not logged in|please run /login|log ?in again|invalid api key|oauth token|authentication|unauthori[sz]ed|\b401\b'
	r'|token (has )?expired|refresh token',
	re.IGNORECASE,
)
LIMIT_PATTERN = re.compile(r'usage limit|rate limit|limit reached|too many requests|\b429\b|quota', re.IGNORECASE)
# A limit on the pace of calls, not on the usage: over within a minute or two.
RATE_PATTERN = re.compile(r'rate limit|too many requests|\b429\b', re.IGNORECASE)
# Seconds a rate-limited call waits before it is asked again; after the last the worker pauses.
RATE_WAITS = (30, 60, 120)
# Calls at a time per login. Two image turns at once on the ChatGPT login ran into
# "429 Too Many Requests" within a minute (DT-1536); single turns did not.
CONCURRENT_CALLS = {'codex': 1}
# The environment a model process gets: enough to find its login and binaries, nothing else.
ENV_KEYS = ('HOME', 'PATH', 'TMPDIR', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM')

Backend = Callable[[str, Sequence], str]


class ModelError(RuntimeError):
	"""The model call failed; the run may be retried."""


class LoginExpired(ModelError):
	"""The subscription login is gone; the worker pauses until it is back."""

	def __init__(self, transport: str, detail: str):
		super().__init__(f'{transport} login expired: {detail}')
		self.transport = transport


class LimitReached(ModelError):
	"""A usage or rate limit was reached; the worker pauses and tries again later."""

	def __init__(self, transport: str, detail: str):
		super().__init__(f'{transport} usage limit: {detail}')
		self.transport = transport


def classify(transport: str, text: str) -> ModelError:
	if LOGIN_PATTERN.search(text):
		return LoginExpired(transport, text[-200:])
	if LIMIT_PATTERN.search(text):
		return LimitReached(transport, text[-200:])
	return ModelError(f'{transport}: {text[-300:]}')


def _clean_env(**extra) -> dict:
	return {**{k: v for k, v in os.environ.items() if k in ENV_KEYS}, **extra}


def _jpeg(image) -> bytes:
	out = io.BytesIO()
	image.convert('RGB').save(out, format='JPEG', quality=90)
	return out.getvalue()


# ---------------------------------------------------------------------------
# Claude (claude -p on the Claude Code login)
# ---------------------------------------------------------------------------


def claude_backend(model: str, run=subprocess.run) -> Backend:
	"""claude -p with no tools at all: the images go inline in the one user message (stream-json)."""

	def ask(prompt: str, images: Sequence) -> str:
		content = []
		for i, image in enumerate(images, 1):
			data = base64.b64encode(_jpeg(image)).decode()
			content += [
				{'type': 'text', 'text': f'Image {i}'},
				{'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/jpeg', 'data': data}},
			]
		message = {'type': 'user', 'message': {'role': 'user', 'content': [*content, {'type': 'text', 'text': prompt}]}}
		command = [
			shutil.which('claude') or 'claude',
			'-p',
			'--model',
			model,
			'--input-format',
			'stream-json',
			'--output-format',
			'stream-json',
			'--verbose',
			'--tools',
			'',
			'--setting-sources',
			'',
			'--strict-mcp-config',
			'--system-prompt',
			'You assess aerial imagery for an audit. Answer with the requested JSON only.',
		]
		with tempfile.TemporaryDirectory(prefix='deadtrees-audit-claude-') as folder:
			try:
				done = run(
					command,
					cwd=folder,
					env=_clean_env(),
					input=json.dumps(message) + '\n',
					capture_output=True,
					text=True,
					timeout=CALL_SECONDS,
				)
			except subprocess.TimeoutExpired as exc:
				raise ModelError(f'claude: no answer within {CALL_SECONDS} s') from exc
		events = []
		for line in done.stdout.splitlines():
			try:
				events.append(json.loads(line))
			except json.JSONDecodeError:
				continue
		init = next((e for e in events if e.get('type') == 'system' and e.get('subtype') == 'init'), {})
		if init.get('tools'):
			raise ModelError(f'claude: tools were offered: {init["tools"]}')
		result = next((e for e in events if e.get('type') == 'result'), None)
		if result is None:
			raise classify('claude', f'{done.stdout[-300:]} {done.stderr[-300:]}')
		if done.returncode or result.get('is_error'):
			raise classify('claude', str(result.get('result') or done.stdout[-300:]))
		return result['result']

	return ask


def claude_logged_in(run=subprocess.run) -> bool:
	try:
		done = run(['claude', 'auth', 'status'], env=_clean_env(), capture_output=True, text=True, timeout=30)
		return done.returncode == 0 and json.loads(done.stdout).get('loggedIn') is True
	except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
		return False


# ---------------------------------------------------------------------------
# Codex (app-server on the ChatGPT login)
# ---------------------------------------------------------------------------

# Everything off but reasoning; mirrors the DT-1272 benchmark transport.
CODEX_FEATURES_OFF = (
	'shell_tool',
	'view_image',
	'apps',
	'plugins',
	'remote_plugin',
	'multi_agent',
	'multi_agent_v2',
	'skill_search',
	'memories',
	'hooks',
	'goals',
	'browser_use',
	'browser_use_external',
	'in_app_browser',
	'image_generation',
	'shell_snapshot',
	'sleep_tool',
	'tool_suggest',
)


def codex_command(effort: str) -> list[str]:
	config = {
		'model_reasoning_effort': effort,
		'project_doc_max_bytes': 0,
		'instructions': '',
		'web_search': 'disabled',
		'features.skip_host_skill_discovery': True,
		**{f'features.{name}': False for name in CODEX_FEATURES_OFF},
	}
	command = [shutil.which('codex') or 'codex', 'app-server', '--stdio']
	for key, value in config.items():
		command += ['-c', f'{key}={json.dumps(value)}']
	return command


def codex_backend(model: str, effort: str = 'medium', popen=subprocess.Popen) -> Backend:
	"""One isolated app-server turn: own CODEX_HOME with only the login, no tools, read-only sandbox."""

	def ask(prompt: str, images: Sequence) -> str:
		auth = Path.home() / '.codex' / 'auth.json'
		if popen is subprocess.Popen and not auth.is_file():
			raise LoginExpired('codex', 'no Codex login on this host')
		with tempfile.TemporaryDirectory(prefix='deadtrees-audit-codex-') as folder:
			home = Path(folder)
			(home / 'empty').mkdir()
			if auth.is_file():
				(home / 'auth.json').symlink_to(auth)
			inputs = [{'type': 'text', 'text': prompt}]
			for i, image in enumerate(images, 1):
				data = base64.b64encode(_jpeg(image)).decode()
				inputs += [
					{'type': 'text', 'text': f'Image {i}'},
					{'type': 'image', 'url': f'data:image/jpeg;base64,{data}', 'detail': 'original'},
				]
			proc = popen(
				codex_command(effort),
				cwd=home / 'empty',
				env=_clean_env(CODEX_HOME=str(home)),
				stdin=subprocess.PIPE,
				stdout=subprocess.PIPE,
				stderr=subprocess.PIPE,
				text=True,
				bufsize=1,
			)
			try:
				return _codex_turn(proc, model, effort, inputs, home / 'empty')
			finally:
				proc.terminate()
				try:
					proc.wait(timeout=5)
				except subprocess.TimeoutExpired:
					proc.kill()

	return ask


def _codex_turn(proc, model: str, effort: str, inputs: list, cwd: Path) -> str:
	lines: queue.Queue = queue.Queue()

	def read():
		for line in proc.stdout:
			lines.put(line)
		lines.put(None)

	threading.Thread(target=read, daemon=True).start()
	deadline = time.monotonic() + CALL_SECONDS

	def send(value):
		proc.stdin.write(json.dumps(value) + '\n')
		proc.stdin.flush()

	def receive():
		remaining = deadline - time.monotonic()
		if remaining <= 0:
			raise ModelError(f'codex: no answer within {CALL_SECONDS} s')
		try:
			line = lines.get(timeout=remaining)
		except queue.Empty:
			raise ModelError(f'codex: no answer within {CALL_SECONDS} s') from None
		if line is None:
			stderr = proc.stderr.read() if proc.stderr else ''
			raise classify('codex', f'app-server exited: {stderr}')
		value = json.loads(line)
		if 'method' in value and 'id' in value:
			# no tool or approval is allowed in an audit turn
			send({'id': value['id'], 'error': {'code': -32601, 'message': 'not allowed'}})
			raise ModelError(f'codex: unexpected request {value["method"]}')
		return value

	def request(number, method, params):
		send({'id': number, 'method': method, 'params': params})
		while True:
			value = receive()
			if value.get('id') == number:
				if 'error' in value:
					raise classify('codex', json.dumps(value['error']))
				return value['result']

	request(
		1,
		'initialize',
		{'clientInfo': {'name': 'deadtrees-audit-worker', 'version': '1'}, 'capabilities': {'experimentalApi': True}},
	)
	send({'method': 'initialized', 'params': {}})
	thread = request(
		2,
		'thread/start',
		{
			'model': model,
			'cwd': str(cwd),
			'ephemeral': True,
			'environments': [],
			'dynamicTools': [],
			'baseInstructions': '',
			'developerInstructions': 'Use only the supplied images. Return the requested JSON.',
			'approvalPolicy': 'never',
			'sandbox': 'read-only',
			'allowProviderModelFallback': False,
		},
	)
	if thread.get('model') != model:
		raise ModelError(f'codex: served {thread.get("model")} instead of {model}')
	request(3, 'turn/start', {'threadId': thread['thread']['id'], 'model': model, 'effort': effort, 'input': inputs})
	answer = None
	while True:
		value = receive()
		method, params = value.get('method'), value.get('params', {})
		if method == 'item/completed' and params.get('item', {}).get('type') == 'agentMessage':
			answer = params['item']['text']
		if method == 'turn/completed':
			turn = params.get('turn', {})
			if turn.get('status') != 'completed':
				raise classify('codex', json.dumps(turn.get('error')))
			break
	if not answer:
		raise ModelError('codex: no final answer')
	return answer


def codex_logged_in(run=subprocess.run) -> bool:
	try:
		done = run(['codex', 'login', 'status'], env=_clean_env(), capture_output=True, text=True, timeout=30)
		return done.returncode == 0 and 'logged in' in f'{done.stdout} {done.stderr}'.lower()
	except (OSError, subprocess.TimeoutExpired):
		return False


TRANSPORTS = {'claude': (claude_backend, claude_logged_in), 'codex': (codex_backend, codex_logged_in)}


_slots = {transport: threading.BoundedSemaphore(calls) for transport, calls in CONCURRENT_CALLS.items()}


def paced(transport: str, backend: Backend, sleep=time.sleep) -> Backend:
	"""The backend at the pace its login takes: no more calls at a time than CONCURRENT_CALLS
	allows, and a rate-limited call waits and is asked again. It keeps its slot while it
	waits, so the other calls on that login wait with it. A usage limit, and a rate limit
	that outlasts the waits, reach the worker, which pauses."""
	slot = _slots.get(transport)

	def ask(prompt: str, images: Sequence) -> str:
		for wait in (*RATE_WAITS, None):
			try:
				return backend(prompt, images)
			except LimitReached as exc:
				if wait is None or not RATE_PATTERN.search(str(exc)):
					raise
			sleep(wait)

	def one_at_a_time(prompt: str, images: Sequence) -> str:
		with slot:
			return ask(prompt, images)

	return one_at_a_time if slot else ask


def judges(models: dict) -> dict[str, Backend]:
	"""Backends from a check version's config: {"luna-medium": {"transport": "codex", "model": ..., "effort": ...}}."""
	out = {}
	for name, spec in models.items():
		make, _ = TRANSPORTS[spec['transport']]
		options = {'effort': spec['effort']} if spec.get('effort') else {}
		out[name] = paced(spec['transport'], make(spec['model'], **options))
	return out


def logged_in(transport: str) -> bool:
	return TRANSPORTS[transport][1]()
