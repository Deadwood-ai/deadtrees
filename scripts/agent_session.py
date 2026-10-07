#!/usr/bin/env python3
"""
Run narrow signed-in checks as the DeadTrees agent account.

The host wrapper `dt-agent-session` injects the credentials as environment
variables, so the calling agent never reads them. Every action signs in, does
one bounded check, signs out and prints one JSON object on stdout. Tokens,
passwords and signed download URLs are never printed.

Environment:
	DEADTREES_AGENT_EMAIL, DEADTREES_AGENT_PASSWORD        agent account
	DEADTREES_AGENT_SUPABASE_URL, DEADTREES_AGENT_SUPABASE_ANON_KEY
	                                                       public Auth endpoint and key
	DEADTREES_AGENT_API_URL                                optional, default production

Examples:
	dt-agent-session whoami
	dt-agent-session get /download/datasets/1234/status
	dt-agent-session download-check 1234 --labels

Exit codes: 0 ok, 1 check failed, 2 usage, 3 missing credentials or sign-in
failed, 7 network.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone

DEFAULT_API_URL = 'https://data2.deadtrees.earth/api/v1'

EXIT_OK, EXIT_FAILED, EXIT_USAGE, EXIT_AUTH, EXIT_NETWORK = 0, 1, 2, 3, 7

SECRET_KEY = re.compile(r'token|secret|password|signature|ticket|authorization|apikey|cookie', re.I)
SECRET_VALUE = re.compile(r'/exports/|[?&](token|sig|signature|x-amz-[a-z-]+)=|^ey[A-Za-z0-9_-]{20,}\.', re.I)
MAX_BODY_CHARS = 20_000


class CheckError(Exception):
	def __init__(self, code: int, message: str, **details):
		super().__init__(message)
		self.code = code
		self.details = details


@dataclass
class Response:
	status: int
	headers: dict[str, str]
	body: bytes

	def json(self):
		try:
			return json.loads(self.body or b'null')
		except ValueError:
			return self.body.decode('utf-8', errors='replace')[:MAX_BODY_CHARS]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
	def redirect_request(self, *args, **kwargs):
		return None


_opener = urllib.request.build_opener(_NoRedirect)


def http(method: str, url: str, headers: dict[str, str], body: bytes | None = None, timeout: int = 60) -> Response:
	"""One request that never follows redirects, so signed Location URLs stay in our hands."""
	request = urllib.request.Request(url, data=body, headers=headers, method=method)
	try:
		with _opener.open(request, timeout=timeout) as response:
			return Response(response.status, dict(response.headers), response.read())
	except urllib.error.HTTPError as error:
		return Response(error.code, dict(error.headers or {}), error.read())
	except (urllib.error.URLError, TimeoutError, OSError) as error:
		raise CheckError(
			EXIT_NETWORK, f'network error: {type(error).__name__}', host=urllib.parse.urlsplit(url).hostname
		)


def redact(value):
	"""Replace credential-looking fields and signed URLs anywhere in a JSON value."""
	if isinstance(value, dict):
		return {k: '[redacted]' if SECRET_KEY.search(str(k)) else redact(v) for k, v in value.items()}
	if isinstance(value, list):
		return [redact(v) for v in value]
	if isinstance(value, str) and SECRET_VALUE.search(value):
		return '[redacted]'
	return value


def mask_email(email: str) -> str:
	local, _, domain = email.partition('@')
	return f'{local[:2]}***@{domain}' if domain else '***'


def jwt_claims(token: str) -> dict:
	payload = token.split('.')[1]
	return json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))


@dataclass
class Session:
	api_url: str
	access_token: str
	claims: dict
	signed_out: bool = False

	@property
	def auth(self) -> dict[str, str]:
		return {'Authorization': f'Bearer {self.access_token}', 'Accept': 'application/json'}

	def api(self, method: str, path: str, **kwargs) -> Response:
		return http(method, self.api_url + '/' + path.lstrip('/'), self.auth, **kwargs)


def _required_env(*names: str) -> list[str]:
	missing = [name for name in names if not os.environ.get(name)]
	if missing:
		raise CheckError(EXIT_AUTH, 'missing credentials', missing=missing)
	return [os.environ[name] for name in names]


@contextmanager
def signed_in(api_url: str):
	"""Sign in with a password grant and always revoke the session afterwards."""
	email, password, auth_url, anon_key = _required_env(
		'DEADTREES_AGENT_EMAIL',
		'DEADTREES_AGENT_PASSWORD',
		'DEADTREES_AGENT_SUPABASE_URL',
		'DEADTREES_AGENT_SUPABASE_ANON_KEY',
	)
	auth_url = auth_url.rstrip('/') + '/auth/v1'
	response = http(
		'POST',
		f'{auth_url}/token?grant_type=password',
		{'apikey': anon_key, 'Content-Type': 'application/json', 'Accept': 'application/json'},
		json.dumps({'email': email, 'password': password}).encode(),
	)
	token = (response.json() or {}).get('access_token') if response.status == 200 else None
	if not token:
		raise CheckError(EXIT_AUTH, 'sign-in failed', http_status=response.status)

	session = Session(api_url.rstrip('/'), token, jwt_claims(token))
	try:
		yield session
	finally:
		# scope=local revokes only this session's refresh token, not the account's other sessions.
		logout = http('POST', f'{auth_url}/logout?scope=local', {**session.auth, 'apikey': anon_key})
		session.signed_out = logout.status in (200, 204)


def whoami(session: Session, _args) -> dict:
	claims = session.claims
	app_metadata = claims.get('app_metadata') or {}
	return {
		'actor_id': claims.get('sub'),
		'email': mask_email(claims.get('email', '')),
		'role': claims.get('role'),
		'internal_test': bool(app_metadata.get('internal_test')),
		'expires_at': datetime.fromtimestamp(claims['exp'], timezone.utc).isoformat(),
	}


def get(session: Session, args) -> dict:
	if re.match(r'^[a-z]+://', args.path) or not args.path.startswith('/'):
		raise CheckError(EXIT_USAGE, 'PATH must be relative to the API, starting with /')
	response = session.api('GET', args.path)
	result = {'path': args.path, 'http_status': response.status, 'body': redact(response.json())}
	if response.status >= 400:
		raise CheckError(EXIT_FAILED, 'request failed', **result)
	return result


def _wait_until_ready(session: Session, start_path: str, status_path: str, wait_s: int) -> dict:
	response = session.api('GET', start_path)
	deadline = time.monotonic() + wait_s
	while True:
		status = response.json() if response.status == 200 else None
		if not isinstance(status, dict):
			raise CheckError(
				EXIT_FAILED, 'download request failed', http_status=response.status, body=redact(response.json())
			)
		if status.get('status') == 'completed':
			return status
		if status.get('status') == 'failed' or time.monotonic() > deadline:
			raise CheckError(
				EXIT_FAILED, 'download not ready', job_status=status.get('status'), detail=status.get('message')
			)
		time.sleep(3)
		response = session.api('GET', status_path)


def _probe_file(session: Session, file_path: str) -> dict:
	"""Follow the API's redirect to the signed file and read only its first byte."""
	redirect = session.api('GET', file_path)
	location = redirect.headers.get('Location') or redirect.headers.get('location')
	if redirect.status not in (302, 303, 307) or not location:
		raise CheckError(EXIT_FAILED, 'no download link issued', http_status=redirect.status)
	target = urllib.parse.urljoin(session.api_url + '/', location)
	# The link is signed; the bearer token only goes back to the API's own host.
	same_host = urllib.parse.urlsplit(target).netloc == urllib.parse.urlsplit(session.api_url).netloc
	probe = http('GET', target, {**(session.auth if same_host else {}), 'Range': 'bytes=0-0'})
	content_range = probe.headers.get('Content-Range') or probe.headers.get('content-range') or ''
	size = content_range.rpartition('/')[2]
	return {
		'filename': urllib.parse.unquote(urllib.parse.urlsplit(target).path.rsplit('/', 1)[-1]),
		'http_status': probe.status,
		'size_bytes': int(size) if size.isdigit() else None,
		'ok': probe.status in (200, 206) and len(probe.body) > 0,
	}


def download_check(session: Session, args) -> dict:
	dataset = f'/download/datasets/{args.dataset_id}'
	targets = []
	if not args.no_bundle:
		targets.append(('bundle', f'{dataset}/dataset.zip', f'{dataset}/status', f'{dataset}/download'))
	if args.labels:
		targets.append(('labels', f'{dataset}/labels.gpkg', f'{dataset}/labels/status', f'{dataset}/labels/download'))
	if not targets:
		raise CheckError(EXIT_USAGE, '--no-bundle needs --labels')

	files = []
	for kind, start, status, download in targets:
		try:
			_wait_until_ready(session, start, status, args.wait)
		except CheckError as error:
			error.details['kind'] = kind
			raise
		files.append({'kind': kind, **_probe_file(session, download)})
	result = {'dataset_id': args.dataset_id, 'files': files}
	if not all(f['ok'] for f in files):
		raise CheckError(EXIT_FAILED, 'download probe failed', **result)
	return result


def parse_args(argv: list[str]) -> argparse.Namespace:
	parser = argparse.ArgumentParser(prog='dt-agent-session', description=__doc__.split('\n\n')[1])
	parser.add_argument('--api-url', default=os.environ.get('DEADTREES_AGENT_API_URL') or DEFAULT_API_URL)
	actions = parser.add_subparsers(dest='action', required=True)
	actions.add_parser('whoami', help='print the actor id, masked email and token expiry').set_defaults(run=whoami)
	get_parser = actions.add_parser('get', help='one signed-in GET on a relative API path')
	get_parser.add_argument('path')
	get_parser.set_defaults(run=get)
	check = actions.add_parser('download-check', help='request a dataset download and probe its first byte')
	check.add_argument('dataset_id', type=int)
	check.add_argument('--labels', action='store_true', help='also check the labels GeoPackage')
	check.add_argument('--no-bundle', action='store_true', help='skip the ortho dataset bundle')
	check.add_argument('--wait', type=int, default=300, help='seconds to wait for a bundle to build')
	check.set_defaults(run=download_check)
	return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
	try:
		args = parse_args(sys.argv[1:] if argv is None else argv)
	except SystemExit as exit_:
		return EXIT_OK if exit_.code == 0 else EXIT_USAGE

	output: dict = {'action': args.action, 'api_url': args.api_url}
	code = EXIT_OK
	session = None
	try:
		with signed_in(args.api_url) as session:
			output.update(ok=True, **args.run(session, args))
	except CheckError as error:
		code = error.code
		output.update(ok=False, error=str(error), **redact(error.details))
	if session is not None:
		output['signed_out'] = session.signed_out
	print(json.dumps(output, indent=2, sort_keys=True))
	return code


if __name__ == '__main__':
	sys.exit(main())
