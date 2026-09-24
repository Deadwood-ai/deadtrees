"""Shared attention order and exact overview/explorer populations."""
import json
import psycopg
import pytest
from api.tests.db.test_factory import authenticate, dataset, db, user  # noqa: F401
from api.tests.db.test_factory_measurements import upload


def page(db, filters):
	return db.execute('SELECT public.factory_datasets(%s,500,0)', (json.dumps(filters),)).fetchone()[0]


def test_overview_and_explorer_share_attention_order_and_waiting_totals(db):
	owner = user(db, operate=True)
	failed = upload(db, owner)
	db.execute('UPDATE public.v2_statuses SET has_error=true WHERE dataset_id=%s', (failed,))
	uncertain = upload(db, owner)
	db.execute("UPDATE public.v2_statuses SET current_status='cog_processing' WHERE dataset_id=%s", (uncertain,))
	authenticate(db, owner)
	operations = db.execute('SELECT public.factory_operations()').fetchone()[0]
	explorer = page(db, dict(attention=True,sort='attention'))
	assert operations['attention_total'] == explorer['total']
	assert [r['dataset_id'] for r in operations['attention']] == [r['dataset_id'] for r in explorer['items'][:10]]
	items = page(db, dict(ids=[failed,uncertain],sort='attention'))['items']
	assert [r['dataset_id'] for r in items] == [failed,uncertain]
	assert items[0]['attention_reason'] == 'failed'
	assert items[0]['attention_since'] is not None
	assert items[1]['attention_reason'] == 'uncertain'
	for group in operations['waiting']:
		assert group['count'] == page(db,group['filters'])['total']


def test_oldest_failures_sort_first_but_unknown_failure_age_is_not_invented(db):
	owner = user(db, operate=True)
	older = upload(db, owner)
	newer = upload(db, owner)
	legacy = dataset(db, owner, has_error=True)
	for row,days in [(older,5),(newer,1)]:
		db.execute('UPDATE public.v2_statuses SET has_error=true WHERE dataset_id=%s', (row,))
		db.execute("UPDATE public.factory_failure_episodes SET failed_at=now()-(%s * interval '1 day') WHERE dataset_id=%s", (days,row))
	# Already failing when every dataset became observed: the start is not invented.
	db.execute('UPDATE public.factory_failure_episodes SET failed_at=NULL WHERE dataset_id=%s', (legacy,))
	authenticate(db, owner)
	result = page(db,dict(ids=[older,newer,legacy],sort='attention'))['items']
	assert [r['dataset_id'] for r in result] == [older,newer,legacy]
	assert result[-1]['attention_since'] is None
	assert result[-1]['attention_reason'] == 'failed'
	assert [r['dataset_id'] for r in page(db,dict(ids=[older,newer,legacy]))['items']] == [legacy,newer,older]


def test_overdue_uses_end_to_end_qualified_upload_and_silence_is_last(db):
	owner = user(db, operate=True)
	overdue = upload(db, owner, size=100)
	large = upload(db, owner, size=2*1073741824)
	zip_row = upload(db, owner, size=100,name='images.zip')
	for row in [overdue,large,zip_row]:
		db.execute("UPDATE public.factory_submissions SET uploaded_at=now()-interval '3 hours' WHERE dataset_id=%s", (row,))
	silent = dataset(db,owner)
	db.execute("UPDATE public.v2_statuses SET updated_at=now()-interval '3 hours' WHERE dataset_id=%s", (silent,))
	db.execute("INSERT INTO public.v2_queue(dataset_id,user_id,is_processing,claimed_at) VALUES(%s,%s,true,now()-interval '2 hours')", (silent,owner))
	authenticate(db,owner)
	result=page(db,dict(ids=[overdue,large,zip_row,silent],attention=True,sort='attention'))['items']
	assert [r['dataset_id'] for r in result] == [overdue,silent]
	assert [r['attention_reason'] for r in result] == ['overdue','silent']


def test_operations_and_private_attention_view_require_operator(db):
	owner=user(db)
	authenticate(db,owner)
	with pytest.raises(psycopg.errors.InsufficientPrivilege),db.transaction():
		db.execute('SELECT public.factory_operations()')
	with pytest.raises(psycopg.errors.InsufficientPrivilege),db.transaction():
		db.execute('SELECT * FROM public.factory_attention_records')


def test_attention_rejects_unsupported_sort(db):
	owner=user(db,operate=True)
	authenticate(db,owner)
	with pytest.raises(psycopg.errors.InvalidParameterValue),db.transaction():
		page(db,dict(sort='arbitrary'))
