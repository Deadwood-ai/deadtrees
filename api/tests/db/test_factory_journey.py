"""Journey observations, authorization and elapsed-window denominators."""
import psycopg
import pytest

from api.tests.db.test_factory import authenticate, dataset, db, user  # noqa: F401
from api.tests.db.test_factory_measurements import upload, ready


def journey(db):
	return db.execute('SELECT public.factory_journey()').fetchone()[0]


def test_only_owner_can_record_ready_result_and_observation_is_immutable(db):
	owner = user(db, operate=True)
	other = user(db, operate=True)
	row = upload(db, owner)
	authenticate(db, owner)
	db.execute('SELECT public.factory_record_result_view(%s)', (row,))
	db.execute('RESET ROLE')
	assert db.execute('SELECT count(*) FROM public.factory_result_views WHERE dataset_id=%s', (row,)).fetchone()[0] == 0
	ready(db, row)
	authenticate(db, other)
	db.execute('SELECT public.factory_record_result_view(%s)', (row,))
	db.execute('RESET ROLE')
	assert db.execute('SELECT count(*) FROM public.factory_result_views WHERE dataset_id=%s', (row,)).fetchone()[0] == 0
	authenticate(db, owner)
	db.execute('SELECT public.factory_record_result_view(%s)', (row,))
	db.execute('RESET ROLE')
	first = db.execute('SELECT viewed_at FROM public.factory_result_views WHERE dataset_id=%s', (row,)).fetchone()[0]
	authenticate(db, owner)
	db.execute('SELECT public.factory_record_result_view(%s)', (row,))
	db.execute('RESET ROLE')
	assert db.execute('SELECT viewed_at FROM public.factory_result_views WHERE dataset_id=%s', (row,)).fetchone()[0] == first


def test_journey_requires_operator_and_private_table_is_not_readable(db):
	owner = user(db)
	authenticate(db, owner)
	with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
		journey(db)
	with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
		db.execute('SELECT * FROM public.factory_result_views')


def test_cohorts_only_include_elapsed_windows_and_known_first_uploads(db):
	db.execute("UPDATE public.factory_measurement_epoch SET started_at=now()-interval '100 days', activation_started_at=now()-interval '100 days'")
	operator = user(db, operate=True)
	owner = user(db)
	first = upload(db, owner)
	second = upload(db, owner)
	ready(db, first)
	db.execute("UPDATE public.factory_submissions SET uploaded_at=now()-interval '40 days',first_ready_at=now()-interval '39 days' WHERE dataset_id=%s", (first,))
	db.execute("UPDATE public.factory_submissions SET uploaded_at=now()-interval '20 days' WHERE dataset_id=%s", (second,))
	db.execute("INSERT INTO public.factory_result_views VALUES (%s,%s,now()-interval '38 days')", (first,owner))
	recent = upload(db, user(db))
	legacy_owner = user(db)
	legacy = dataset(db, legacy_owner)
	db.execute("UPDATE public.v2_datasets SET created_at='2020-01-01' WHERE id=%s", (legacy,))
	db.execute('UPDATE public.v2_statuses SET is_upload_done=true WHERE dataset_id=%s', (legacy,))
	upload(db, legacy_owner)
	authenticate(db, operator)
	result = journey(db)
	older = next(c for c in result['cohorts'] if c['retention_eligible'] > 0 and c['returned_30d'] > 0)
	assert older['activated_7d'] >= 1
	assert older['returned_30d'] >= 1
	current = result['cohorts'][0]
	assert current['activation_eligible'] == 0
	assert current['activated_7d'] is None
	assert current['retention_eligible'] == 0
	assert current['returned_30d'] is None
	# Synthetic fixture populations can coexist; these owners contribute exactly two cohorts.
	db.execute('RESET ROLE')
	assert db.execute('SELECT dataset_id FROM public.factory_submissions WHERE dataset_id=%s', (recent,)).fetchone()


def test_pre_tracking_buckets_are_unknown_and_zero_is_only_after_epoch(db):
	operator = user(db, operate=True)
	db.execute('UPDATE public.factory_measurement_epoch SET started_at=now(),activation_started_at=now()')
	authenticate(db, operator)
	result = journey(db)
	assert len(result['weekly']) == 12
	assert result['weekly'][0]['uploads'] is None
	assert result['weekly'][0]['observed_views'] is None
	assert result['weekly'][-1]['partial'] is True
	assert result['weekly'][-1]['observed_views'] is not None


def test_activation_excludes_uploads_before_observation_started(db):
	owner = user(db, operate=True)
	row = upload(db, owner)
	ready(db, row)
	db.execute("UPDATE public.factory_submissions SET uploaded_at=now()-interval '110 days',first_ready_at=now()-interval '109 days' WHERE dataset_id=%s", (row,))
	db.execute('UPDATE public.factory_measurement_epoch SET activation_started_at=now()')
	authenticate(db, owner)
	result = journey(db)
	oldest = result['cohorts'][-1]
	assert oldest['activation_eligible'] == 0
	assert oldest['activated_7d'] is None
	assert oldest['retention_eligible'] >= 1
	assert oldest['returned_30d'] == 0


def test_pipeline_counts_match_existing_filters(db):
	owner = user(db, operate=True)
	upload(db, owner)
	authenticate(db, owner)
	result = journey(db)['pipeline']
	for key, filters in [('uploaded', {'uploaded': True}), ('ready', {'ready': True}),
	 ('queued', {'state': 'queued'}), ('processing', {'state': 'claimed'}),
	 ('failed', {'has_error': True}), ('audited', {'has_audit': True}), ('published', {'publication': 'published'})]:
		import json
		page = db.execute('SELECT public.factory_datasets(%s)', (json.dumps(filters),)).fetchone()[0]
		assert result[key] == page['total']


def test_cohorts_are_bounded_to_recent_26_calendar_weeks(db):
	operator = user(db, operate=True)
	for weeks in range(30):
		row = upload(db, user(db))
		db.execute("UPDATE public.factory_submissions SET uploaded_at=date_trunc('week',now())-%s*interval '1 week' WHERE dataset_id=%s", (weeks,row))
	authenticate(db, operator)
	cohorts = journey(db)['cohorts']
	assert len(cohorts) == 26
