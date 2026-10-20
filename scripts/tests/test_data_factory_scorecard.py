import importlib.util
import subprocess
from pathlib import Path

ROOT = Path(__file__).parents[2]
SCORECARD = ROOT / 'scripts' / 'data_factory_scorecard.py'
SCORECARD_SPEC = importlib.util.spec_from_file_location('data_factory_scorecard_tests', SCORECARD)
assert SCORECARD_SPEC is not None and SCORECARD_SPEC.loader is not None
scorecard = importlib.util.module_from_spec(SCORECARD_SPEC)
SCORECARD_SPEC.loader.exec_module(scorecard)


def test_run_psql_disables_gss_encryption_for_the_pooler(monkeypatch):
	monkeypatch.setenv('PGGSSENCMODE', 'prefer')
	calls: list[dict] = []

	def fake_run(args, **kwargs):
		calls.append({'args': args, **kwargs})
		return subprocess.CompletedProcess(args, 0, stdout='{}', stderr='')

	monkeypatch.setattr(scorecard.subprocess, 'run', fake_run)

	scorecard.run_psql('postgresql://analyst@pooler:6543/postgres', timeout=5)

	assert calls[0]['args'][0] == 'psql'
	assert calls[0]['env']['PGGSSENCMODE'] == 'disable'
