import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
SPEC = importlib.util.spec_from_file_location('release_stale_queue_claim_tests', ROOT / 'scripts' / 'release_stale_queue_claim.py')
assert SPEC is not None and SPEC.loader is not None
release_script = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release_script)


@pytest.fixture
def env_file(tmp_path):
	path = tmp_path / 'requeue.env'
	path.write_text('SUPABASE_URL=https://db.example/\nSUPABASE_KEY=anon\nPROCESSOR_USERNAME=u\nPROCESSOR_PASSWORD=p\n')
	return path


def run(monkeypatch, env_file, responses, dataset_ids='15538'):
	calls = []

	def http_json(method, url, headers, body, timeout_s=60):
		calls.append((method, url, body, headers.get('Authorization')))
		return responses.pop(0)

	monkeypatch.setattr(release_script, '_http_json', http_json)
	monkeypatch.setattr(release_script, '_login', lambda env, url: 'jwt')
	monkeypatch.setattr(sys, 'argv', ['release', '--env-file', str(env_file), '--dataset-ids', dataset_ids])
	return release_script.main(), calls


def test_release_calls_the_rpc_once_per_dataset(monkeypatch, env_file, capsys):
	code, calls = run(monkeypatch, env_file, [(200, {'id': 54145}), (200, {'id': 54146})], dataset_ids='15538,15539')

	assert code == 0
	assert calls == [
		('POST', 'https://db.example/rest/v1/rpc/release_stale_queue_claim', {'p_dataset_id': 15538}, 'Bearer jwt'),
		('POST', 'https://db.example/rest/v1/rpc/release_stale_queue_claim', {'p_dataset_id': 15539}, 'Bearer jwt'),
	]
	assert 'dataset_id=15538 released queue task 54145' in capsys.readouterr().out


def test_refusal_is_reported_and_fails_the_run(monkeypatch, env_file, capsys):
	refusal = {'code': '55006', 'message': 'Worker host-x last sent a heartbeat at 2026-10-29; a claim is released only after 00:15:00 of silence.'}
	code, _ = run(monkeypatch, env_file, [(400, refusal)])

	assert code == 4
	assert 'refused (HTTP 400): Worker host-x' in capsys.readouterr().out


def test_env_file_is_required(monkeypatch):
	monkeypatch.setattr(sys, 'argv', ['release', '--dataset-ids', '1'])
	with pytest.raises(SystemExit):
		release_script.main()
