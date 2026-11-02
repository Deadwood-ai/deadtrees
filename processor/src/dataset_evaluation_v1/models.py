"""The vision models behind one small interface: a model takes the prompt and named
JPEG images and returns the reply text with a usage receipt.

Haiku runs through a minimal headless Claude Code call (`claude -p`, no settings, no
MCP, only the Read tool for the image files). Luna runs through the OpenAI Responses
API with a key file; the subscription worker (DT-1482) can add its own transport
under the same interface. A missing or expired login raises ModelUnavailable, so the
worker leaves the run queued instead of failing it.
"""

import base64
import json
import os
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class ModelUnavailable(RuntimeError):
	"""The model cannot be reached with the configured login; retry later."""


class ModelBusy(RuntimeError):
	"""The model is over capacity or rate limited; retry after a pause."""


@dataclass
class Reply:
	text: str
	usage: dict = field(default_factory=dict)
	seconds: float = 0.0


class Model(Protocol):
	name: str  # audit.assessments.model, e.g. 'haiku-5.5'

	def __call__(self, prompt: str, images: list[tuple[str, bytes]]) -> Reply: ...


AUTH_HINTS = (
	'please run /login',
	'invalid api key',
	'oauth token has expired',
	'authentication_error',
	'not logged in',
	'credit balance is too low',
)
BUSY_HINTS = ('overloaded', 'rate limit', 'rate_limit', 'at capacity', '529')


@dataclass
class HaikuCLI:
	name: str = 'haiku-5.5'
	model: str = 'claude-haiku-5-5'
	binary: str = 'claude'
	timeout: int = 600

	def __call__(self, prompt: str, images: list[tuple[str, bytes]]) -> Reply:
		started = time.monotonic()
		with tempfile.TemporaryDirectory(prefix='dataset-evaluation-') as folder:
			names = []
			for name, data in images:
				(Path(folder) / name).write_bytes(data)
				names.append(name)
			files = ', '.join(names)
			command = [
				self.binary,
				'-p',
				'--model',
				self.model,
				'--output-format',
				'json',
				'--tools',
				'Read',
				'--allowedTools',
				'Read',
				'--setting-sources',
				'',
				'--strict-mcp-config',
				'--system-prompt',
				'You assess aerial orthophotos. Use the Read tool only to view the image files '
				'named in the request, then answer with the requested JSON only.',
				f'Read {files} in this folder; they are Image 1 to Image {len(names)} in that order.\n\n{prompt}',
			]
			try:
				done = subprocess.run(
					command, cwd=folder, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=self.timeout
				)
			except FileNotFoundError:
				raise ModelUnavailable(f'{self.binary} is not installed') from None
			except subprocess.TimeoutExpired:
				raise ModelBusy(f'{self.name} timed out after {self.timeout} s') from None
		# stdout only: Claude Code prints warnings about newer model names on stderr.
		try:
			result = json.loads(done.stdout)
		except json.JSONDecodeError:
			result = {'is_error': True, 'result': done.stdout[-500:] or done.stderr[-500:]}
		if done.returncode or result.get('is_error'):
			message = str(result.get('result'))[:300].lower()
			if any(h in message for h in AUTH_HINTS):
				raise ModelUnavailable(f'{self.name}: {message}')
			if any(h in message for h in BUSY_HINTS):
				raise ModelBusy(f'{self.name}: {message}')
			raise RuntimeError(f'{self.name} failed: {message}')
		usage = (result.get('modelUsage') or {}).get(self.model, {})
		return Reply(
			text=result.get('result') or '',
			usage={
				'input_tokens': usage.get('inputTokens', 0)
				+ usage.get('cacheReadInputTokens', 0)
				+ usage.get('cacheCreationInputTokens', 0),
				'output_tokens': usage.get('outputTokens', 0),
				'turns': result.get('num_turns'),
				'cost_usd': None,  # subscription inference has no dollar cost; unknown, not zero
			},
			seconds=round(time.monotonic() - started, 1),
		)


@dataclass
class LunaResponses:
	key_file: Path
	name: str = 'luna-medium'
	model: str = 'gpt-6-luna'
	effort: str = 'medium'
	url: str = 'https://api.openai.com/v1/responses'
	timeout: int = 300

	def key(self) -> str:
		"""OPENAI_API_KEY from the protected env file; the value is never logged."""
		try:
			for line in Path(self.key_file).read_text().splitlines():
				if line.startswith('OPENAI_API_KEY='):
					return line.split('=', 1)[1].strip().strip('"\'')
		except OSError:
			pass
		raise ModelUnavailable(f'No OPENAI_API_KEY in {self.key_file}')

	def __call__(self, prompt: str, images: list[tuple[str, bytes]]) -> Reply:
		started = time.monotonic()
		content = [{'type': 'input_text', 'text': prompt}] + [
			{
				'type': 'input_image',
				'detail': 'original',
				'image_url': 'data:image/jpeg;base64,' + base64.b64encode(data).decode(),
			}
			for _, data in images
		]
		payload = {
			'model': self.model,
			'input': [{'role': 'user', 'content': content}],
			'reasoning': {'effort': self.effort},
		}
		request = Request(
			self.url,
			data=json.dumps(payload).encode(),
			method='POST',
			headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + self.key()},
		)
		try:
			with urlopen(request, timeout=self.timeout) as response:
				raw = json.loads(response.read(4_000_001))
		except HTTPError as e:
			if e.code in (401, 403):
				raise ModelUnavailable(f'{self.name}: HTTP {e.code}') from None
			if e.code in (429, 500, 502, 503, 504):
				raise ModelBusy(f'{self.name}: HTTP {e.code}') from None
			raise RuntimeError(f'{self.name}: HTTP {e.code}') from None
		except (URLError, TimeoutError) as e:
			raise ModelBusy(f'{self.name}: {e}') from None
		text = ''.join(
			c.get('text', '')
			for item in raw.get('output', [])
			if item.get('type') == 'message'
			for c in item.get('content', [])
		)
		usage = raw.get('usage') or {}
		return Reply(
			text=text,
			usage={
				'input_tokens': usage.get('input_tokens'),
				'output_tokens': usage.get('output_tokens'),
				'cost_usd': None,
			},
			seconds=round(time.monotonic() - started, 1),
		)


def default_models(openai_key_file: str | None = None) -> list[Model]:
	"""Luna and Haiku, the pair whose answers are averaged."""
	key_file = openai_key_file or os.environ.get(
		'DATASET_EVALUATION_OPENAI_KEY_FILE', str(Path.home() / '.config/deadtrees/openai.env')
	)
	return [LunaResponses(Path(key_file)), HaikuCLI()]
