"""Status rows, processing logs and admin read models are not open to every role."""
import json
import uuid
from urllib.parse import urlparse

import psycopg
import pytest

from shared.settings import settings

PROCESSOR_EMAIL = 'processor@deadtrees.earth'


@pytest.fixture
def db():
	assert urlparse(settings.SUPABASE_DB_URL).hostname in {'localhost', '127.0.0.1', 'host.docker.internal'}, 'Local database required'
	with psycopg.connect(settings.SUPABASE_DB_URL, user='supabase_admin') as connection:
		try:
			yield connection
		finally:
			connection.rollback()


def as_admin(db):
	db.execute('RESET ROLE')
	db.execute("SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)")


def as_anon(db):
	db.execute('RESET ROLE')
	db.execute('SET LOCAL ROLE anon')
	db.execute("SELECT set_config('request.jwt.claims','{\"role\":\"anon\"}',true)")


def act_as(db, user, email=None):
	db.execute('RESET ROLE')
	db.execute('SET LOCAL ROLE authenticated')
	claims = {'sub': str(user), 'role': 'authenticated', **({'email': email} if email else {})}
	db.execute("SELECT set_config('request.jwt.claims',%s,true)", (json.dumps(claims),))


def create_user(db, can_audit=False, can_operate=False, email=None):
	as_admin(db)
	user = uuid.uuid4()
	db.execute('INSERT INTO auth.users(id,email) VALUES (%s,%s)', (user, email or f'{user}@example.invalid'))
	if can_audit or can_operate:
		db.execute(
			'INSERT INTO public.privileged_users(user_id,can_audit,can_operate) VALUES (%s,%s,%s)',
			(user, can_audit, can_operate),
		)
	return user


def create_dataset(db, owner, data_access='public'):
	as_admin(db)
	return db.execute(
		"INSERT INTO public.v2_datasets(user_id,file_name,license,platform,data_access) "
		"VALUES (%s,'access.tif','CC BY','drone',%s) RETURNING id",
		(owner, data_access),
	).fetchone()[0]


def expect_denied(db, statement, params=()):
	db.execute('SAVEPOINT denied')
	with pytest.raises(psycopg.errors.InsufficientPrivilege):
		db.execute(statement, params)
	db.execute('ROLLBACK TO SAVEPOINT denied')


INSERT_STATUS = 'INSERT INTO public.v2_statuses(dataset_id) VALUES (%s)'


def test_status_rows_are_created_by_owners_auditors_and_the_processor(db):
	owner, other, auditor = create_user(db), create_user(db), create_user(db, can_audit=True)
	processor = uuid.uuid4()
	datasets = [create_dataset(db, owner) for _ in range(3)]

	as_anon(db)
	expect_denied(db, INSERT_STATUS, (datasets[0],))
	act_as(db, other)
	expect_denied(db, INSERT_STATUS, (datasets[0],))

	for user, email, dataset in [(owner, None, datasets[0]), (auditor, None, datasets[1]), (processor, PROCESSOR_EMAIL, datasets[2])]:
		act_as(db, user, email)
		db.execute(INSERT_STATUS, (dataset,))

	as_admin(db)
	db.execute('SAVEPOINT duplicate')
	with pytest.raises(psycopg.errors.UniqueViolation):
		db.execute(INSERT_STATUS, (datasets[0],))
	db.execute('ROLLBACK TO SAVEPOINT duplicate')


def test_logs_are_private_to_their_writer_operators_and_the_processor(db):
	owner, other = create_user(db), create_user(db)
	operator = create_user(db, can_operate=True)
	public_dataset, private_dataset = create_dataset(db, owner), create_dataset(db, owner, 'private')
	insert = "INSERT INTO public.v2_logs(level,message,category,dataset_id,user_id) VALUES ('ERROR','Processing failed: forged','process',%s,%s)"

	as_admin(db)
	own_line = db.execute(
		"INSERT INTO public.v2_logs(level,message,dataset_id,user_id) VALUES ('INFO','owner line',%s,%s) RETURNING id",
		(private_dataset, owner),
	).fetchone()[0]

	as_anon(db)
	expect_denied(db, 'SELECT id FROM public.v2_logs LIMIT 1')
	expect_denied(db, insert, (public_dataset, None))

	act_as(db, other)
	assert db.execute('SELECT id FROM public.v2_logs WHERE id=%s', (own_line,)).fetchall() == []
	expect_denied(db, insert, (private_dataset, other))  # a dataset they cannot see
	expect_denied(db, insert, (public_dataset, owner))  # a line attributed to someone else
	db.execute(insert, (public_dataset, other))
	db.execute(insert, (None, None))

	for user, email in [(owner, None), (operator, None), (uuid.uuid4(), PROCESSOR_EMAIL)]:
		act_as(db, user, email)
		assert db.execute('SELECT id FROM public.v2_logs WHERE id=%s', (own_line,)).fetchall() == [(own_line,)]


def test_admin_read_models_are_not_public(db):
	owner, other, auditor = create_user(db), create_user(db), create_user(db, can_audit=True)
	shown, excluded = create_dataset(db, owner), create_dataset(db, owner)
	as_admin(db)
	for dataset in (shown, excluded):
		db.execute(
			"INSERT INTO public.v2_statuses(dataset_id,has_error,error_message) VALUES (%s,true,'boom at /data/x')", (dataset,)
		)
	db.execute("INSERT INTO public.dataset_audit(dataset_id,final_assessment) VALUES (%s,'exclude_completely')", (excluded,))
	read = 'SELECT id, error_message FROM public.v2_full_dataset_view WHERE id = ANY(%s) ORDER BY id'

	as_anon(db)
	expect_denied(db, 'SELECT 1 FROM public.v_export_polygon_candidates LIMIT 1')
	assert db.execute(read, ([shown, excluded],)).fetchall() == [(shown, None)]
	assert db.execute(
		'SELECT id, error_message FROM public.v2_full_dataset_view_public WHERE id = ANY(%s)', ([shown, excluded],)
	).fetchall() == [(shown, None)]

	act_as(db, other)
	expect_denied(db, 'SELECT 1 FROM public.v_export_polygon_candidates LIMIT 1')
	assert db.execute(read, ([shown, excluded],)).fetchall() == [(shown, None), (excluded, None)]

	for user in (owner, auditor):
		act_as(db, user)
		assert [error for _, error in db.execute(read, ([shown, excluded],)).fetchall()] == ['boom at /data/x'] * 2
