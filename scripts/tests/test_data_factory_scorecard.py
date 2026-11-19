import importlib.util
import re
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


def latest_function_body(name: str) -> str:
	"""The body of the newest migration that (re)defines a SQL function."""
	pattern = re.compile(rf'create or replace function public\.{name}\(.*?\$\$(.*?)\$\$;', re.S | re.I)
	for migration in sorted((ROOT / 'supabase' / 'migrations').glob('*.sql'), reverse=True):
		match = pattern.search(migration.read_text())
		if match:
			return match.group(1)
	raise AssertionError(f'no migration defines {name}')


def squash(sql: str) -> str:
	return ' '.join(sql.replace('p_error_stage', 's.error_stage').replace('p_error_message', 's.error_message').split())


def test_failure_groups_copy_the_factory_stage_and_kind_functions():
	# The analyst role may not execute these functions, so the scorecard copies
	# them; this fails when a migration changes one without the copy.
	query = squash(scorecard.SCORECARD_SQL)
	stage = squash(latest_function_body('factory_failure_stage')).removeprefix('select ')
	assert stage.endswith(' as raw) s;')
	assert stage.removesuffix(' s;') + ' r) as stage' in query
	kind = squash(latest_function_body('factory_failure_kind')).removeprefix('select ').removesuffix(';')
	assert f"coalesce({kind}, 'unknown') as kind" in query
