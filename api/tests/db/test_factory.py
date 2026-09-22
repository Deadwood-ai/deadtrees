"""Factory capability and read-model contracts against isolated PostgreSQL."""

import json
import uuid

import psycopg
import pytest

from shared.settings import settings


@pytest.fixture
def db():
	with psycopg.connect(settings.SUPABASE_DB_URL, user='supabase_admin') as connection:
		try:
			yield connection
		finally:
			connection.rollback()


def user(db, *, operate=False, audit=False):
	identity = uuid.uuid4()
	db.execute('INSERT INTO auth.users (id,email) VALUES (%s,%s)', (identity, f'{identity}@example.invalid'))
	db.execute(
		'INSERT INTO public.privileged_users (user_id,can_operate,can_audit) VALUES (%s,%s,%s)',
		(identity, operate, audit),
	)
	return identity


def authenticate(db, identity):
	db.execute(
		"SELECT set_config('request.jwt.claims',%s,true)",
		(json.dumps({'sub': str(identity), 'role': 'authenticated'}),),
	)
	db.execute('SET LOCAL ROLE authenticated')


def dataset(db, owner, **kwargs):
	row = db.execute(
		"INSERT INTO public.v2_datasets (user_id,file_name,license,platform,data_access) VALUES (%s,%s,'CC BY','drone','private') RETURNING id",
		(owner, kwargs.pop('file_name', 'factory-test.tif')),
	).fetchone()[0]
	db.execute('INSERT INTO public.v2_statuses (dataset_id) VALUES (%s)', (row,))
	if kwargs:
		from psycopg import sql

		db.execute(
			sql.SQL('UPDATE public.v2_statuses SET {} WHERE dataset_id=%s').format(
				sql.SQL(',').join(sql.SQL('{}=%s').format(sql.Identifier(k)) for k in kwargs)
			),
			(*kwargs.values(), row),
		)
	return row


@pytest.mark.parametrize(
	'function,args',
	[
		('factory_overview', '7'),
		('factory_datasets', "'{}',50,0"),
		('factory_dataset', '1'),
		('factory_activity', "'all',50,0"),
	],
)
def test_auditor_without_factory_permission_is_denied(db, function, args):
	identity = user(db, audit=True)
	authenticate(db, identity)
	assert db.execute('SELECT public.can_operate()').fetchone()[0] is False
	with pytest.raises(psycopg.errors.InsufficientPrivilege):
		db.execute(f'SELECT public.{function}({args})')


@pytest.mark.parametrize(
	'query',
	[
		'SELECT public.factory_overview()',
		'SELECT public.factory_datasets()',
		'SELECT public.factory_dataset(1)',
		'SELECT public.factory_activity()',
	],
)
def test_anonymous_rpc_is_denied(db, query):
	db.execute('SET LOCAL ROLE anon')
	with pytest.raises(psycopg.errors.InsufficientPrivilege):
		db.execute(query)


def test_operator_metadata_does_not_grant_private_imagery_or_audit(db):
	owner = user(db)
	operator = user(db, operate=True)
	row = dataset(db, owner)
	authenticate(db, operator)
	assert db.execute(
		'SELECT public.can_operate(),public.can_audit(),public.can_view_all_private_data()'
	).fetchone() == (True, False, False)
	result = db.execute('SELECT public.factory_dataset(%s)', (row,)).fetchone()[0]
	assert result['dataset']['dataset_id'] == row
	assert result['dataset']['user_email'] == f'{owner}@example.invalid'
	assert db.execute('SELECT id FROM public.v2_datasets WHERE id=%s', (row,)).fetchall() == []
	assert result['dataset']['state'] == 'incomplete'
	assert not result['dataset']['is_ready']


@pytest.mark.parametrize(
	'query',
	[
		'SELECT * FROM public.factory_dataset_records',
		"SELECT * FROM public.factory_filtered_datasets('{}')",
		'UPDATE public.privileged_users SET can_operate=true',
	],
)
def test_internal_read_model_and_self_promotion_denied(db, query):
	identity = user(db, audit=True)
	authenticate(db, identity)
	if query.startswith('UPDATE'):
		assert db.execute(query).rowcount == 0
		assert not db.execute('SELECT public.can_operate()').fetchone()[0]
	else:
		with pytest.raises(psycopg.errors.InsufficientPrivilege):
			db.execute(query)


def test_full_collection_filters_old_claim_pagination_and_readiness(db):
	operator = user(db, operate=True)
	old = dataset(db, operator, is_upload_done=True)
	db.execute(
		"INSERT INTO public.v2_queue (dataset_id,user_id,is_processing,claimed_by,claimed_at) VALUES (%s,%s,true,'fixture-worker',now())",
		(old, operator),
	)
	for _ in range(105):
		dataset(db, operator)
	ready = dataset(
		db,
		operator,
		is_upload_done=True,
		is_ortho_done=True,
		is_metadata_done=True,
		is_cog_done=True,
		is_thumbnail_done=True,
		is_combined_model_done=True,
	)
	zip_incomplete = dataset(
		db,
		operator,
		file_name='needs-odm.zip',
		is_upload_done=True,
		is_ortho_done=True,
		is_metadata_done=True,
		is_cog_done=True,
		is_thumbnail_done=True,
		is_combined_model_done=True,
	)
	authenticate(db, operator)
	filters = {'contributor': str(operator)}
	result = db.execute('SELECT public.factory_datasets(%s,50,0)', (json.dumps(filters),)).fetchone()[0]
	assert result['total'] == 108
	assert len(result['items']) == 50
	last = db.execute('SELECT public.factory_datasets(%s,50,100)', (json.dumps(filters),)).fetchone()[0]
	assert len(last['items']) == 8 and last['items'][-1]['dataset_id'] == old
	claimed = db.execute(
		'SELECT public.factory_datasets(%s)', (json.dumps({**filters, 'state': 'claimed'}),)
	).fetchone()[0]
	assert claimed['total'] == 1 and claimed['items'][0]['dataset_id'] == old
	assert claimed['items'][0]['intent'] == 'unknown'
	assert db.execute('SELECT public.factory_dataset(%s)', (ready,)).fetchone()[0]['dataset']['is_ready']
	assert not db.execute('SELECT public.factory_dataset(%s)', (zip_incomplete,)).fetchone()[0]['dataset']['is_ready']
	selected = db.execute('SELECT public.factory_datasets(%s)', (json.dumps({'ids': [old, ready]}),)).fetchone()[0]
	assert selected['total'] == 2
	assert {x['dataset_id'] for x in selected['items']} == {old, ready}
	overview = db.execute('SELECT public.factory_overview()').fetchone()[0]
	assert any(x['dataset_id'] == old for x in overview['workers'])
	assert overview['counts']['uncertain'] == db.execute(
		'SELECT public.factory_datasets(%s)', (json.dumps({'state': 'uncertain'}),)
	).fetchone()[0]['total']


def test_notifications_activity_and_archived_selection(db):
	operator = user(db, operate=True)
	row = dataset(db, operator)
	db.execute('UPDATE public.v2_datasets SET archived=true WHERE id=%s', (row,))
	db.execute(
		"INSERT INTO public.processing_notification_events (queue_task_id,dataset_id,event_type,recipient_user_id,recipient_email,status,provider_message_id,status_snapshot) VALUES (987654322,%s,'processing_failed',%s,'hidden@example.invalid','failed','excluded-provider-id','{\"secret\":true}')",
		(row, operator),
	)
	authenticate(db, operator)
	assert db.execute('SELECT public.factory_datasets(%s)', (json.dumps({'ids': [row]}),)).fetchone()[0]['total'] == 0
	result = db.execute(
		'SELECT public.factory_datasets(%s)',
		(json.dumps({'ids': [row], 'archived': 'all', 'notification': 'problem'}),),
	).fetchone()[0]
	assert result['total'] == 1 and result['items'][0]['notification_problem']
	detail = db.execute('SELECT public.factory_dataset(%s)', (row,)).fetchone()[0]
	assert detail['notifications'][0]['status'] == 'failed'
	assert 'recipient_email' not in detail['notifications'][0]
	assert 'provider_message_id' not in detail['notifications'][0]
	assert 'status_snapshot' not in detail['notifications'][0]
	activity = db.execute("SELECT public.factory_activity('notifications')").fetchone()[0]
	assert any(x['dataset_id'] == row and x['state'] == 'failed' for x in activity['items'])


@pytest.mark.parametrize(
	'query',
	[
		"SELECT public.factory_datasets('{}',501,0)",
		"SELECT public.factory_datasets('{}',50,-1)",
		"SELECT public.factory_datasets('[]')",
		'SELECT public.factory_overview(0)',
		"SELECT public.factory_activity('not-a-kind')",
	],
)
def test_invalid_inputs(db, query):
	authenticate(db, user(db, operate=True))
	with pytest.raises(psycopg.errors.InvalidParameterValue):
		db.execute(query)


def test_missing_dataset_returns_not_found_contract(db):
	authenticate(db, user(db, operate=True))
	assert db.execute('SELECT public.factory_dataset(-1)').fetchone()[0]['dataset'] is None
