import base64
import importlib.util
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[2]
SPEC = importlib.util.spec_from_file_location('agent_session', ROOT / 'scripts' / 'agent_session.py')
assert SPEC is not None and SPEC.loader is not None
agent_session = importlib.util.module_from_spec(SPEC)
sys.modules['agent_session'] = agent_session  # dataclasses resolve annotations through sys.modules
SPEC.loader.exec_module(agent_session)

PASSWORD = 'pw-never-printed'
TICKET = 'tkt-never-printed'


def _jwt(claims: dict) -> str:
	encode = lambda part: base64.urlsafe_b64encode(json.dumps(part).encode()).decode().rstrip('=')  # noqa: E731
	return f'{encode({"alg": "HS256"})}.{encode(claims)}.signature-part'


TOKEN = _jwt(
	{
		'sub': 'agent-uuid',
		'email': 'agent-check@example.org',
		'role': 'authenticated',
		'exp': 2_000_000_000,
		'app_metadata': {'internal_test': True},
	}
)


class FakePlatform(BaseHTTPRequestHandler):
	logouts: list[str] = []

	def log_message(self, *_):
		pass

	def _send(self, status: int, body=None, headers=None):
		payload = json.dumps(body).encode() if body is not None else b''
		self.send_response(status)
		for key, value in (headers or {}).items():
			self.send_header(key, value)
		self.send_header('Content-Length', str(len(payload)))
		self.end_headers()
		self.wfile.write(payload)

	def do_POST(self):
		if self.path == '/auth/v1/token?grant_type=password':
			body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
			if body['password'] != PASSWORD:
				return self._send(400, {'error': 'invalid_grant'})
			return self._send(200, {'access_token': TOKEN, 'refresh_token': 'refresh-never-printed'})
		if self.path == '/auth/v1/logout?scope=local':
			FakePlatform.logouts.append(self.headers['Authorization'])
			return self._send(204)
		self._send(404)

	def do_GET(self):
		if self.headers.get('Authorization') != f'Bearer {TOKEN}' and not self.path.startswith('/exports/'):
			return self._send(401, {'detail': 'Invalid token'})
		if self.path in ('/api/v1/download/datasets/7/dataset.zip', '/api/v1/download/datasets/7/status'):
			return self._send(
				200, {'status': 'completed', 'job_id': '7', 'download_path': f'/exports/{TICKET}/7/a.zip'}
			)
		if self.path == '/api/v1/download/datasets/7/download':
			return self._send(303, headers={'Location': f'/exports/{TICKET}/7/7_ortho.zip'})
		if self.path == f'/exports/{TICKET}/7/7_ortho.zip':
			assert self.headers['Range'] == 'bytes=0-0'
			self.send_response(206)
			self.send_header('Content-Range', 'bytes 0-0/4096')
			self.send_header('Content-Length', '1')
			self.end_headers()
			return self.wfile.write(b'P')
		if self.path == '/api/v1/download/datasets/8/dataset.zip':
			return self._send(403, {'detail': 'no access'})
		self._send(404, {'detail': 'not found'})


@pytest.fixture
def platform(monkeypatch):
	server = ThreadingHTTPServer(('127.0.0.1', 0), FakePlatform)
	threading.Thread(target=server.serve_forever, daemon=True).start()
	base = f'http://127.0.0.1:{server.server_port}'
	FakePlatform.logouts = []
	monkeypatch.setenv('DEADTREES_AGENT_EMAIL', 'agent-check@example.org')
	monkeypatch.setenv('DEADTREES_AGENT_PASSWORD', PASSWORD)
	monkeypatch.setenv('DEADTREES_AGENT_SUPABASE_URL', base)
	monkeypatch.setenv('DEADTREES_AGENT_SUPABASE_ANON_KEY', 'anon-key')
	monkeypatch.setenv('DEADTREES_AGENT_API_URL', f'{base}/api/v1')
	yield base
	server.shutdown()


def run(capsys, *argv):
	code = agent_session.main(list(argv))
	out = capsys.readouterr().out
	for secret in (PASSWORD, TOKEN, TICKET, 'refresh-never-printed', 'agent-check@'):
		assert secret not in out
	return code, json.loads(out)


def test_whoami_reports_identity_and_signs_out(platform, capsys):
	code, out = run(capsys, 'whoami')

	assert code == 0
	assert out['actor_id'] == 'agent-uuid'
	assert out['email'] == 'ag***@example.org'
	assert out['internal_test'] is True
	assert out['expires_at'].startswith('2033-05-18')
	assert out['signed_out'] is True
	assert FakePlatform.logouts == [f'Bearer {TOKEN}']


def test_download_check_probes_first_byte_without_printing_the_link(platform, capsys):
	code, out = run(capsys, 'download-check', '7')

	assert code == 0
	assert out['files'] == [
		{'kind': 'bundle', 'filename': '7_ortho.zip', 'http_status': 206, 'size_bytes': 4096, 'ok': True}
	]
	assert out['signed_out'] is True


def test_get_redacts_signed_links(platform, capsys):
	code, out = run(capsys, 'get', '/download/datasets/7/status')

	assert code == 0
	assert out['body']['download_path'] == '[redacted]'


def test_denied_download_fails_and_still_signs_out(platform, capsys):
	code, out = run(capsys, 'download-check', '8')

	assert code == 1
	assert out['http_status'] == 403
	assert out['signed_out'] is True


def test_wrong_password_is_an_auth_failure(platform, capsys, monkeypatch):
	monkeypatch.setenv('DEADTREES_AGENT_PASSWORD', 'wrong')
	code, out = run(capsys, 'whoami')

	assert code == 3
	assert out == {
		'action': 'whoami',
		'api_url': f'{platform}/api/v1',
		'error': 'sign-in failed',
		'http_status': 400,
		'ok': False,
	}


def test_absolute_urls_are_rejected(platform, capsys):
	code, out = run(capsys, 'get', 'https://elsewhere.example/x')

	assert code == 2
	assert out['signed_out'] is True


def test_network_failure_has_its_own_exit_code(capsys, monkeypatch, platform):
	monkeypatch.setenv('DEADTREES_AGENT_SUPABASE_URL', 'http://127.0.0.1:9')
	code, out = run(capsys, 'whoami')

	assert code == 7
	assert out['error'] == 'network error: URLError'


def test_untrusted_api_url_gets_no_sign_in(platform, capsys):
	code, out = run(capsys, '--api-url', 'https://attacker.example/api/v1', 'whoami')

	assert code == 2
	assert out['host'] == 'attacker.example'
	assert 'signed_out' not in out


def test_local_api_needs_local_auth(platform, capsys, monkeypatch):
	monkeypatch.setenv('DEADTREES_AGENT_SUPABASE_URL', 'https://auth.example')
	code, _ = run(capsys, 'whoami')

	assert code == 2
