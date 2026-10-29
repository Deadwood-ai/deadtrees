"""release_stale_queue_claim contracts on isolated PostgreSQL: who may call it, the silence gate, and what it changes."""
import json
import uuid
from urllib.parse import urlparse

import psycopg
import pytest

from shared.settings import settings

WORKER = 'host-test-dead'


def local_db_url():
	assert urlparse(settings.SUPABASE_DB_URL).hostname in {'localhost', '127.0.0.1', 'host.docker.internal'}, 'Local database required'
	return settings.SUPABASE_DB_URL


@pytest.fixture
def db():
	with psycopg.connect(local_db_url(), user='supabase_admin') as conn:
		try:
			yield conn
		finally:
			conn.rollback()


def create_user(db, can_view_all_private=False):
	user = uuid.uuid4()
	db.execute('INSERT INTO auth.users(id,email) VALUES (%s,%s)', (user, f'{user}@example.invalid'))
	if can_view_all_private:
		db.execute('INSERT INTO public.privileged_users(user_id,can_view_all_private) VALUES (%s,true)', (user,))
	return user


def act_as(db, user, email=None):
	db.execute('RESET ROLE')
	db.execute('SET LOCAL ROLE authenticated')
	claims = {'sub': str(user), 'role': 'authenticated', 'email': email or f'{user}@example.invalid'}
	db.execute("SELECT set_config('request.jwt.claims',%s,true)", (json.dumps(claims),))


def as_admin(db):
	db.execute('RESET ROLE')
	db.execute("SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)")


def claimed_dataset(
	db, owner, claimed_minutes_ago=60, heartbeat_minutes_ago=30, continuous=True, status='odm_processing', has_error=False
):
	as_admin(db)
	dataset = db.execute(
		"INSERT INTO public.v2_datasets(user_id,file_name,license,platform,data_access) VALUES (%s,'claim.tif','CC BY','drone','public') RETURNING id",
		(owner,),
	).fetchone()[0]
	db.execute(
		'INSERT INTO public.v2_statuses(dataset_id,current_status,has_error) VALUES (%s,%s,%s)', (dataset, status, has_error)
	)
	queue_id = db.execute(
		"INSERT INTO public.v2_queue(dataset_id,user_id,task_types,priority,is_processing,claimed_by,claimed_at) "
		"VALUES (%s,%s,'{odm_processing,geotiff}',3,true,%s,now() - make_interval(mins => %s)) RETURNING id",
		(dataset, owner, WORKER, claimed_minutes_ago),
	).fetchone()[0]
	if heartbeat_minutes_ago is not None:
		db.execute(
			'INSERT INTO public.processor_heartbeats(worker_id,seen_at) VALUES (%s,now() - make_interval(mins => %s)) '
			'ON CONFLICT (worker_id) DO UPDATE SET seen_at = excluded.seen_at',
			(WORKER, heartbeat_minutes_ago),
		)
		db.execute(
			'UPDATE public.processor_heartbeats SET continuous_seen_at = CASE WHEN %s THEN seen_at END WHERE worker_id=%s',
			(continuous, WORKER),
		)
	return dataset, queue_id


def release(db, dataset):
	return db.execute(
		'SELECT id, is_processing, claimed_by, claimed_at, task_types, priority FROM public.release_stale_queue_claim(%s)', (dataset,)
	).fetchone()


def expect_refused(db, sqlstate, dataset):
	with pytest.raises(psycopg.Error) as error:
		with db.transaction():
			release(db, dataset)
	assert error.value.sqlstate == sqlstate
	return error.value


def queue_state(db, dataset):
	as_admin(db)
	return db.execute(
		'SELECT is_processing, claimed_by FROM public.v2_queue WHERE dataset_id=%s', (dataset,)
	).fetchone()


def status_of(db, dataset):
	as_admin(db)
	return db.execute('SELECT current_status, has_error FROM public.v2_statuses WHERE dataset_id=%s', (dataset,)).fetchone()


def test_privileged_user_releases_a_silent_workers_claim_and_resets_status(db):
	owner, operator = create_user(db), create_user(db, can_view_all_private=True)
	dataset, queue_id = claimed_dataset(db, owner)

	act_as(db, operator)
	task_id, is_processing, claimed_by, claimed_at, task_types, priority = release(db, dataset)

	assert (task_id, is_processing, claimed_by, claimed_at) == (queue_id, False, None, None)
	assert task_types == ['odm_processing', 'geotiff'] and priority == 3
	assert queue_state(db, dataset) == (False, None)
	assert status_of(db, dataset) == ('idle', False)
	log = db.execute(
		"SELECT user_id, extra->>'event', extra->>'worker_id', (extra->>'queue_id')::bigint FROM public.v2_logs WHERE dataset_id=%s",
		(dataset,),
	).fetchall()
	assert log == [(operator, 'claim_released', WORKER, queue_id)]


def test_processor_account_may_release(db):
	owner, processor = create_user(db), create_user(db)
	dataset, _ = claimed_dataset(db, owner)

	act_as(db, processor, email='processor@deadtrees.earth')
	release(db, dataset)

	assert queue_state(db, dataset) == (False, None)


def test_worker_without_a_heartbeat_row_is_refused(db):
	owner, operator = create_user(db), create_user(db, can_view_all_private=True)
	as_admin(db)
	db.execute('DELETE FROM public.processor_heartbeats WHERE worker_id=%s', (WORKER,))
	dataset, _ = claimed_dataset(db, owner, heartbeat_minutes_ago=None)

	act_as(db, operator)
	expect_refused(db, '55006', dataset)

	assert queue_state(db, dataset) == (True, WORKER)


def test_worker_on_an_older_release_is_never_released(db):
	# Older processors write seen_at only between tasks, so a busy one looks silent.
	owner, operator = create_user(db), create_user(db, can_view_all_private=True)
	dataset, _ = claimed_dataset(db, owner, continuous=False)

	act_as(db, operator)
	error = expect_refused(db, '55006', dataset)

	assert 'does not send heartbeats while processing' in str(error)
	assert queue_state(db, dataset) == (True, WORKER)


def test_worker_rolled_back_to_an_older_release_is_never_released(db):
	owner, operator = create_user(db), create_user(db, can_view_all_private=True)
	dataset, _ = claimed_dataset(db, owner)
	as_admin(db)
	# The old release updates seen_at only, leaving an older continuous_seen_at behind.
	db.execute("UPDATE public.processor_heartbeats SET seen_at = seen_at + interval '1 minute' WHERE worker_id=%s", (WORKER,))

	act_as(db, operator)
	expect_refused(db, '55006', dataset)

	assert queue_state(db, dataset) == (True, WORKER)


@pytest.mark.parametrize(
	'claimed_minutes_ago, heartbeat_minutes_ago',
	[(60, 5), (5, 60)],
	ids=['worker-still-alive', 'claim-just-taken'],
)
def test_live_worker_or_fresh_claim_is_refused_without_changes(db, claimed_minutes_ago, heartbeat_minutes_ago):
	owner, operator = create_user(db), create_user(db, can_view_all_private=True)
	dataset, _ = claimed_dataset(db, owner, claimed_minutes_ago=claimed_minutes_ago, heartbeat_minutes_ago=heartbeat_minutes_ago)

	act_as(db, operator)
	error = expect_refused(db, '55006', dataset)

	assert WORKER in str(error)
	assert queue_state(db, dataset) == (True, WORKER)
	assert status_of(db, dataset) == ('odm_processing', False)


def test_ordinary_user_even_the_owner_is_refused(db):
	owner = create_user(db)
	dataset, _ = claimed_dataset(db, owner)

	act_as(db, owner)
	expect_refused(db, '42501', dataset)

	assert queue_state(db, dataset) == (True, WORKER)


def test_anonymous_callers_cannot_execute_it(db):
	owner = create_user(db)
	dataset, _ = claimed_dataset(db, owner)
	db.execute('RESET ROLE')
	db.execute('SET LOCAL ROLE anon')

	expect_refused(db, '42501', dataset)


def test_dataset_without_a_claim_is_not_found(db):
	owner, operator = create_user(db), create_user(db, can_view_all_private=True)
	dataset, _ = claimed_dataset(db, owner)
	as_admin(db)
	db.execute('UPDATE public.v2_queue SET is_processing=false, claimed_by=null, claimed_at=null WHERE dataset_id=%s', (dataset,))

	act_as(db, operator)
	expect_refused(db, 'P0002', dataset)


def test_failed_dataset_keeps_its_error_and_status(db):
	owner, operator = create_user(db), create_user(db, can_view_all_private=True)
	dataset, _ = claimed_dataset(db, owner, status='odm_processing', has_error=True)

	act_as(db, operator)
	release(db, dataset)

	assert queue_state(db, dataset) == (False, None)
	assert status_of(db, dataset) == ('odm_processing', True)
