"""requeue_dataset_processing contracts on isolated PostgreSQL: authorization, atomicity and races."""
import json
import threading
import uuid
from urllib.parse import urlparse

import psycopg
import pytest

from shared.models import TaskTypeEnum
from shared.settings import settings

ALL_DONE_FLAGS = (
	'is_odm_done',
	'is_ortho_done',
	'is_metadata_done',
	'is_cog_done',
	'is_thumbnail_done',
	'is_deadwood_done',
	'is_forest_cover_done',
	'is_combined_model_done',
	'is_aoi_done',
	'is_embeddings_done',
	'is_doy_estimation_done',
)


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


def create_dataset(db, owner, data_access='public', with_status=True):
	dataset = db.execute(
		"INSERT INTO public.v2_datasets(user_id,file_name,license,platform,data_access) VALUES (%s,'requeue.tif','CC BY','drone',%s) RETURNING id",
		(owner, data_access),
	).fetchone()[0]
	if with_status:
		db.execute('INSERT INTO public.v2_statuses(dataset_id) VALUES (%s)', (dataset,))
	return dataset


def act_as(db, user):
	db.execute('RESET ROLE')
	db.execute('SET LOCAL ROLE authenticated')
	db.execute("SELECT set_config('request.jwt.claims',%s,true)", (json.dumps({'sub': str(user), 'role': 'authenticated'}),))


def as_admin(db):
	db.execute('RESET ROLE')
	db.execute("SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)")


def requeue(db, dataset, task_types, priority=2):
	return db.execute(
		'SELECT id, user_id, task_types, priority, is_processing FROM public.requeue_dataset_processing(%s,%s,%s)',
		(dataset, task_types, priority),
	).fetchone()


def expect_rejected(db, sqlstate, dataset, task_types, priority=2):
	with pytest.raises(psycopg.Error) as error:
		with db.transaction():
			requeue(db, dataset, task_types, priority)
	assert error.value.sqlstate == sqlstate
	return error.value


def queue_rows(db, dataset):
	as_admin(db)
	return db.execute(
		'SELECT id, user_id, task_types, is_processing FROM public.v2_queue WHERE dataset_id=%s ORDER BY id', (dataset,)
	).fetchall()


def insert_queue_row(db, dataset, user, is_processing=False, claimed_by=None):
	as_admin(db)
	return db.execute(
		"INSERT INTO public.v2_queue(dataset_id,user_id,task_types,is_processing,claimed_by) VALUES (%s,%s,'{metadata}',%s,%s) RETURNING id",
		(dataset, user, is_processing, claimed_by),
	).fetchone()[0]


def status_row(db, dataset, columns):
	as_admin(db)
	row = db.execute(f'SELECT {", ".join(columns)} FROM public.v2_statuses WHERE dataset_id=%s', (dataset,)).fetchone()
	return dict(zip(columns, row))


def test_privileged_non_owner_replaces_the_owners_waiting_task(db):
	owner, auditor = create_user(db), create_user(db, can_view_all_private=True)
	dataset = create_dataset(db, owner, data_access='private')
	insert_queue_row(db, dataset, owner)

	act_as(db, auditor)
	task_id, task_user, task_types, _, _ = requeue(db, dataset, ['geotiff', 'cog'])

	assert queue_rows(db, dataset) == [(task_id, auditor, ['geotiff', 'cog'], False)]
	assert task_user == auditor and task_types == ['geotiff', 'cog']


def test_requeue_twice_leaves_one_task(db):
	owner = create_user(db)
	dataset = create_dataset(db, owner)

	act_as(db, owner)
	requeue(db, dataset, ['metadata'])
	second_id = requeue(db, dataset, ['cog'], priority=5)[0]

	assert queue_rows(db, dataset) == [(second_id, owner, ['cog'], False)]


@pytest.mark.parametrize('claim', [{'is_processing': True}, {'claimed_by': 'worker-1'}])
def test_claimed_or_active_task_blocks_requeue_without_changes(db, claim):
	owner = create_user(db)
	dataset = create_dataset(db, owner)
	claimed_id = insert_queue_row(db, dataset, owner, **claim)
	as_admin(db)
	db.execute("UPDATE public.v2_statuses SET has_error=true, error_message='failed' WHERE dataset_id=%s", (dataset,))

	act_as(db, owner)
	error = expect_rejected(db, '55006', dataset, ['metadata'])

	assert 'stop the active processing container' in str(error)
	assert [row[0] for row in queue_rows(db, dataset)] == [claimed_id]
	assert status_row(db, dataset, ['has_error', 'error_message']) == {'has_error': True, 'error_message': 'failed'}


def test_busy_status_without_error_blocks_requeue(db):
	owner = create_user(db)
	dataset = create_dataset(db, owner)
	as_admin(db)
	db.execute("UPDATE public.v2_statuses SET current_status='cog_processing' WHERE dataset_id=%s", (dataset,))

	act_as(db, owner)
	expect_rejected(db, '55006', dataset, ['metadata'])
	assert queue_rows(db, dataset) == []


def test_failure_after_status_reset_rolls_everything_back(db):
	owner = create_user(db)
	dataset = create_dataset(db, owner)
	old_task = insert_queue_row(db, dataset, owner)
	as_admin(db)
	db.execute(
		"UPDATE public.v2_statuses SET has_error=true, error_message='stale failure', error_stage='cog', is_cog_done=true WHERE dataset_id=%s",
		(dataset,),
	)
	# Fail the final queue insert, after the status reset and queue delete ran.
	db.execute(
		"""
		CREATE FUNCTION pg_temp.fail_queue_insert() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'simulated queue insert failure'; END $$;
		CREATE TRIGGER fail_queue_insert BEFORE INSERT ON public.v2_queue
		FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_queue_insert();
		"""
	)

	act_as(db, owner)
	expect_rejected(db, 'P0001', dataset, ['cog'])

	assert [row[0] for row in queue_rows(db, dataset)] == [old_task]
	assert status_row(db, dataset, ['has_error', 'error_message', 'error_stage', 'is_cog_done']) == {
		'has_error': True,
		'error_message': 'stale failure',
		'error_stage': 'cog',
		'is_cog_done': True,
	}


def test_failed_status_resets_only_requested_stage_flags(db):
	owner = create_user(db)
	dataset = create_dataset(db, owner)
	as_admin(db)
	db.execute(
		f"UPDATE public.v2_statuses SET has_error=true, error_message='x', current_status='cog_processing', "
		f"{', '.join(f'{flag}=true' for flag in ALL_DONE_FLAGS)} WHERE dataset_id=%s",
		(dataset,),
	)

	act_as(db, owner)
	requeue(db, dataset, ['geotiff', 'deadwood_treecover_combined_v2', 'aoi_v1'])

	status = status_row(db, dataset, ['has_error', 'error_message', 'current_status', 'is_aoi_required', *ALL_DONE_FLAGS])
	reset = {'is_ortho_done', 'is_combined_model_done', 'is_aoi_done'}
	assert status == {
		'has_error': False,
		'error_message': None,
		'current_status': 'idle',
		'is_aoi_required': True,
		**{flag: flag not in reset for flag in ALL_DONE_FLAGS},
	}


def test_every_task_type_is_accepted_and_resets_its_own_flag(db):
	owner = create_user(db)
	dataset = create_dataset(db, owner)
	as_admin(db)
	db.execute(
		f"UPDATE public.v2_statuses SET has_error=true, {', '.join(f'{flag}=true' for flag in ALL_DONE_FLAGS)} WHERE dataset_id=%s",
		(dataset,),
	)

	act_as(db, owner)
	requeue(db, dataset, [task_type.value for task_type in TaskTypeEnum])

	assert status_row(db, dataset, ALL_DONE_FLAGS) == {flag: False for flag in ALL_DONE_FLAGS}


def test_missing_status_row_is_created_only_for_aoi(db):
	owner = create_user(db)
	plain, aoi = create_dataset(db, owner, with_status=False), create_dataset(db, owner, with_status=False)

	act_as(db, owner)
	requeue(db, plain, ['metadata'])
	requeue(db, aoi, ['geotiff', 'aoi_v1'])

	as_admin(db)
	statuses = db.execute(
		'SELECT dataset_id, is_aoi_required FROM public.v2_statuses WHERE dataset_id = ANY(%s)', ([plain, aoi],)
	).fetchall()
	assert statuses == [(aoi, True)]


def test_callers_without_rights_are_rejected_without_changes(db):
	owner, stranger = create_user(db), create_user(db)
	public_dataset = create_dataset(db, owner)
	private_dataset = create_dataset(db, owner, data_access='private')
	owner_task = insert_queue_row(db, public_dataset, owner)

	act_as(db, stranger)
	expect_rejected(db, '42501', public_dataset, ['metadata'])
	expect_rejected(db, 'P0002', private_dataset, ['metadata'])
	expect_rejected(db, 'P0002', -1, ['metadata'])
	act_as(db, owner)
	expect_rejected(db, '22023', public_dataset, ['not_a_task'])
	expect_rejected(db, '22023', public_dataset, ['metadata'], priority=6)

	assert [row[0] for row in queue_rows(db, public_dataset)] == [owner_task]


def test_anon_cannot_execute(db):
	owner = create_user(db)
	dataset = create_dataset(db, owner)
	db.execute('SET LOCAL ROLE anon')
	expect_rejected(db, '42501', dataset, ['metadata'])


# Races: two real connections with committed data (rollback-only fixtures cannot show commit order).


@pytest.fixture
def committed_dataset():
	with psycopg.connect(local_db_url(), user='supabase_admin', autocommit=True) as admin:
		owner = create_user(admin)
		dataset = None
		try:
			dataset = create_dataset(admin, owner)
			yield admin, dataset, owner
		finally:
			if dataset:
				for table in ('v2_queue', 'v2_statuses'):
					admin.execute(f'DELETE FROM public.{table} WHERE dataset_id=%s', (dataset,))
				admin.execute('DELETE FROM public.v2_datasets WHERE id=%s', (dataset,))
			admin.execute('DELETE FROM auth.users WHERE id=%s', (owner,))


def run_in_thread(action):
	outcome = {}

	def target():
		try:
			outcome['result'] = action()
		except Exception as error:  # noqa: BLE001 - asserted by the caller
			outcome['error'] = error

	thread = threading.Thread(target=target)
	thread.start()
	return thread, outcome


def requeue_and_commit(owner, dataset, task_types):
	with psycopg.connect(local_db_url(), user='supabase_admin') as conn:
		act_as(conn, owner)
		task_id = requeue(conn, dataset, task_types)[0]
		conn.commit()
		return task_id


def test_concurrent_requeues_leave_one_task(committed_dataset):
	admin, dataset, owner = committed_dataset
	with psycopg.connect(local_db_url(), user='supabase_admin') as first:
		act_as(first, owner)
		requeue(first, dataset, ['metadata'])

		thread, outcome = run_in_thread(lambda: requeue_and_commit(owner, dataset, ['cog']))
		thread.join(timeout=1)
		assert thread.is_alive(), 'the second requeue must wait for the first'
		first.commit()

	thread.join(timeout=10)
	assert 'error' not in outcome
	rows = admin.execute('SELECT id, task_types FROM public.v2_queue WHERE dataset_id=%s', (dataset,)).fetchall()
	assert rows == [(outcome['result'], ['cog'])]


def test_worker_claim_during_requeue_finds_the_task_replaced(committed_dataset):
	admin, dataset, owner = committed_dataset
	waiting = admin.execute(
		"INSERT INTO public.v2_queue(dataset_id,user_id,task_types) VALUES (%s,%s,'{metadata}') RETURNING id", (dataset, owner)
	).fetchone()[0]

	def worker_claim():
		# Same conditional update as processor/src/utils/queue_runtime.claim_task.
		with psycopg.connect(local_db_url(), user='supabase_admin') as worker:
			claimed = worker.execute(
				"UPDATE public.v2_queue SET is_processing=true, claimed_by='worker-1', claimed_at=now() "
				'WHERE id=%s AND is_processing=false AND claimed_by IS NULL RETURNING id',
				(waiting,),
			).fetchall()
			worker.commit()
			return claimed

	with psycopg.connect(local_db_url(), user='supabase_admin') as api:
		act_as(api, owner)
		new_task = requeue(api, dataset, ['cog'])[0]

		thread, outcome = run_in_thread(worker_claim)
		thread.join(timeout=1)
		assert thread.is_alive(), 'the worker claim must wait for the requeue'
		api.commit()

	thread.join(timeout=10)
	assert outcome == {'result': []}
	rows = admin.execute('SELECT id, is_processing FROM public.v2_queue WHERE dataset_id=%s', (dataset,)).fetchall()
	assert rows == [(new_task, False)]
