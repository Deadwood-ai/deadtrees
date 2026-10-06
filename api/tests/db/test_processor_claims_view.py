"""v2_processor_claims contract on isolated PostgreSQL: readable claims, operator-only access."""
import uuid
from urllib.parse import urlparse

import psycopg
import pytest

from shared.settings import settings


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


def claimed_dataset(db, owner, worker_id, file_name):
	dataset = db.execute(
		"INSERT INTO public.v2_datasets (user_id,file_name,license,platform,data_access) "
		"VALUES (%s,%s,'CC BY','drone','private') RETURNING id",
		(owner, file_name),
	).fetchone()[0]
	db.execute(
		"INSERT INTO public.v2_statuses (dataset_id,current_status,uploaded_input_bytes) VALUES (%s,'cog_processing',%s)",
		(dataset, 5 * 1048576),
	)
	db.execute(
		"INSERT INTO public.v2_queue (dataset_id,user_id,task_types,is_processing,claimed_by,claimed_at,created_at) "
		"VALUES (%s,%s,'{cog}',true,%s,now() - interval '5 minutes',now() - interval '1 hour')",
		(dataset, owner, worker_id),
	)
	return dataset


def test_claims_show_host_dataset_stage_and_latest_log(db):
	owner = uuid.uuid4()
	db.execute('INSERT INTO auth.users (id) VALUES (%s)', (owner,))
	known = claimed_dataset(db, owner, 'host-f9760a054cb8', 'known-host.tif')
	unknown = claimed_dataset(db, owner, 'host-000000000000', 'new-host.tif')
	db.execute(
		"INSERT INTO public.v2_logs (dataset_id,level,category,message,created_at,backend_version) VALUES "
		"(%s,'INFO','process','before this claim',now() - interval '2 hours','0.1'),"
		"(%s,'INFO','cog','Converting to COG',now() - interval '1 minute','0.2')",
		(known, known),
	)

	rows = {
		row[0]: row[1:]
		for row in db.execute(
			'SELECT dataset_id, processor, dataset, stage, running_for, waited_in_queue, input_size_mb, '
			'last_log, backend_version, worker_id FROM public.v2_processor_claims WHERE dataset_id = ANY(%s)',
			([known, unknown],),
		).fetchall()
	}

	processor, dataset, stage, running_for, waited, size_mb, last_log, version, worker_id = rows[known]
	assert (processor, dataset, stage, worker_id) == ('processing-server', 'known-host.tif', 'cog_processing', 'host-f9760a054cb8')
	assert running_for.total_seconds() >= 300 and waited.total_seconds() == 3300
	assert (size_mb, last_log, version) == (5, 'Converting to COG', '0.2')

	processor, *_, last_log, version, worker_id = rows[unknown]
	assert (processor, worker_id, last_log, version) == ('host-000000000000', 'host-000000000000', None, None)


def test_waiting_rows_are_not_claims(db):
	owner = uuid.uuid4()
	db.execute('INSERT INTO auth.users (id) VALUES (%s)', (owner,))
	dataset = claimed_dataset(db, owner, 'host-f9760a054cb8', 'waiting.tif')
	db.execute('UPDATE public.v2_queue SET is_processing=false, claimed_by=NULL, claimed_at=NULL WHERE dataset_id=%s', (dataset,))

	assert db.execute('SELECT count(*) FROM public.v2_processor_claims WHERE dataset_id=%s', (dataset,)).fetchone()[0] == 0


@pytest.mark.parametrize('role', ['anon', 'authenticated'])
def test_app_roles_cannot_read_claims(db, role):
	db.execute(f'SET LOCAL ROLE {role}')
	with pytest.raises(psycopg.errors.InsufficientPrivilege):
		db.execute('SELECT 1 FROM public.v2_processor_claims')


def test_analyst_can_read_claims(db):
	db.execute('SET LOCAL ROLE analyst')
	db.execute('SELECT 1 FROM public.v2_processor_claims')
