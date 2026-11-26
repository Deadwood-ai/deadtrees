"""The dataset evaluation's call under its rules (audit.evaluation_calls, docs/dataset-evaluation.md)."""

from api.tests.db.test_acquisition_date_estimates import as_admin, create_dataset, create_user, db  # noqa: F401
from api.tests.db.test_audit_checks import add_rules, create_run, dataset_judgement, finish, register_version


def call(db, dataset, judgements=(), **evidence):
	version = register_version(db, 'dataset_evaluation', f'de-call-{dataset}')
	finish(db, create_run(db, dataset, version, check='dataset_evaluation'), dataset_judgements=judgements, evidence=evidence)
	as_admin(db)
	return db.execute(
		'SELECT decision::text, verdict::text, reason, cog_issue, thumbnail_issue FROM audit.evaluation_calls WHERE dataset_id=%s',
		(dataset,),
	).fetchone()


def test_the_deciding_judge_decides_and_a_fix_keeps_the_dataset(db):
	owner = create_user(db)
	luna = dataset_judgement('luna-medium', 'major', reason='no_trees')
	cases = {
		'ok': ('keep', 'ok', None, True, False),
		'minor': ('keep', 'minor', None, True, False),
		'major': ('exclude', 'major', 'blurry', True, False),
		'not_assessable': (None, 'not_assessable', None, True, False),
	}
	for verdict, expected in cases.items():
		dataset = create_dataset(db, owner)
		haiku = dataset_judgement('haiku-5.5', verdict, cog=True, reason='blurry' if verdict == 'major' else None)
		assert call(db, dataset, [luna, haiku]) == expected, verdict
	# the call names the deciding judgement
	assert db.execute(
		'SELECT j.judge FROM audit.evaluation_calls c JOIN audit.dataset_vlm_judgements j ON j.id = c.judgement_id WHERE c.dataset_id=%s',
		(dataset,),
	).fetchone() == ('haiku-5.5',)
	# without the deciding judge's answer nobody decides; the other judges are shown, not counted
	assert call(db, create_dataset(db, owner), [luna]) == (None, None, None, None, None)


def test_an_empty_cog_and_a_band_layout_that_is_no_photo_exclude_without_a_model(db):
	owner = create_user(db)
	assert call(db, create_dataset(db, owner), empty=True) == ('exclude', 'major', 'broken_ortho', False, False)
	haiku = dataset_judgement('haiku-5.5', 'ok', cog=True)
	assert call(db, create_dataset(db, owner), [haiku], band_check={'likelihood': 95}) == ('exclude', 'major', 'not_rgb', True, False)
	# below the rules' threshold the band check only informs
	assert call(db, create_dataset(db, owner), [haiku], band_check={'likelihood': 85}) == ('keep', 'ok', None, True, False)


def test_migrated_versions_keep_the_call_their_runs_recorded_until_new_rules_go_on(db):
	"""The dataset evaluation's v1 and v2 rules (mean and spread of the models) are not worked out again:
	"call": "recorded" reads each run's recorded call (runs.evidence.rule), as the rewrite migrated it."""
	owner = create_user(db)
	version = register_version(db, 'dataset_evaluation', 'de-recorded', rules={'call': 'recorded', 'band_major_at': 90})
	datasets = {}
	for verdict, rule in (
		('unsure', {'verdict': 'unsure'}),
		('minor', {'verdict': 'minor', 'fix_flags': ['cog_issue']}),
		('major', {'verdict': 'major', 'reason': 'no_trees', 'fix_flags': []}),
	):
		dataset = datasets[verdict] = create_dataset(db, owner)
		finish(
			db,
			create_run(db, dataset, version, check='dataset_evaluation'),
			dataset_judgements=[dataset_judgement('haiku-5.5', 'ok')],
			evidence={'rule': rule},
		)
	read = 'SELECT decision::text, verdict::text, reason, cog_issue, judgement_id FROM audit.evaluation_calls WHERE dataset_id=%s'
	assert [db.execute(read, (datasets[v],)).fetchone() for v in ('unsure', 'minor', 'major')] == [
		(None, None, None, None, None),
		('keep', 'minor', None, True, None),
		('exclude', 'major', 'no_trees', False, None),
	]
	# rules with a decider re-work every call from the stored answers at once
	db.execute('SELECT audit.activate_rules(%s)', (add_rules(db, version, {'decider': 'haiku', 'band_major_at': 90}, 'rules-v3'),))
	assert {db.execute(read, (d,)).fetchone()[0] for d in datasets.values()} == {'keep'}
