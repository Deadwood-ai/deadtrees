"""Real SQL-role/RLS contract, using only the isolated API test database."""

import uuid

import psycopg
from psycopg import sql
import pytest

from shared.settings import settings


ROLE = 'deadtrees_operator_status'


@pytest.fixture
def db():
	connection = psycopg.connect(settings.SUPABASE_DB_URL, user='supabase_admin')
	try:
		yield connection
	finally:
		connection.rollback()
		connection.close()


def as_role(db, role):
	db.execute(sql.SQL('SET LOCAL ROLE {}').format(sql.Identifier(role)))


def test_monitor_reads_private_workflows_without_changing_app_visibility(db):
	owner, outsider, project = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
	db.execute('INSERT INTO auth.users (id) VALUES (%s), (%s)', (owner, outsider))
	dataset = db.execute(
		"INSERT INTO public.v2_datasets (user_id, file_name, license, platform, data_access) "
		"VALUES (%s, 'operator-test.tif', 'CC BY', 'drone', 'private') RETURNING id", (owner,)
	).fetchone()[0]
	publication = db.execute(
		"INSERT INTO public.data_publication (user_id, status) VALUES (%s, 'pending') RETURNING id", (owner,)
	).fetchone()[0]
	db.execute('INSERT INTO public.jt_data_publication_datasets VALUES (%s, %s)', (publication, dataset))
	db.execute('INSERT INTO public.dataset_audit (dataset_id) VALUES (%s)', (dataset,))
	flag = db.execute(
		"INSERT INTO public.dataset_flags (dataset_id, created_by, description) "
		"VALUES (%s, %s, 'Private report') RETURNING id", (dataset, owner)
	).fetchone()[0]
	db.execute(
		"INSERT INTO public.processing_notification_events "
		"(queue_task_id, dataset_id, event_type, recipient_user_id, recipient_email) "
		"VALUES (987654321, %s, 'processing_failed', %s, 'private@example.invalid')", (dataset, owner)
	)
	db.execute("INSERT INTO public.priwa_projects (id, slug, name) VALUES (%s, %s, 'Private project')", (project, str(project)))
	tree = db.execute(
		"INSERT INTO public.priwa_kaeferbaeume "
		"(project_id, geom, location_source, fund, baumart, bm, bohrloch, harz, nadel, name, datum, created_by, updated_by) "
		"VALUES (%s, ST_SetSRID(ST_MakePoint(8.2, 48.4),4326), 'qr_exact', 'fresh', 'Fichte', "
		"'ja', 'nein', 'ja', 'braun', 'Private observer', current_date, %s, %s) RETURNING id", (project, owner, owner)
	).fetchone()[0]
	definition = db.execute(
		"INSERT INTO public.prepackaged_dataset_definitions (slug, title, summary, kind) "
		"VALUES (%s, 'Test', 'Test', 'vector') RETURNING id", (str(uuid.uuid4()),)
	).fetchone()[0]
	version = db.execute(
		"INSERT INTO public.prepackaged_dataset_versions "
		"(definition_id, version, file_name, storage_path, public_download_path, size_bytes) "
		"VALUES (%s, 'test', 'test.zip', 'test', 'test', 1) RETURNING id", (definition,)
	).fetchone()[0]
	grant = db.execute(
		"INSERT INTO public.prepackaged_dataset_download_grants (version_id, user_id, token_hash, expires_at) "
		"VALUES (%s, %s, %s, now() + interval '1 hour') RETURNING id", (version, owner, str(uuid.uuid4()))
	).fetchone()[0]
	as_role(db, ROLE)
	assert db.execute('SELECT id FROM public.v2_datasets WHERE id = %s', (dataset,)).fetchall() == [(dataset,)]
	assert db.execute(
		'SELECT p.status, count(j.dataset_id) FROM public.data_publication p '
		'JOIN public.jt_data_publication_datasets j ON j.publication_id = p.id '
		'WHERE p.id = %s GROUP BY p.status', (publication,)
	).fetchall() == [('pending', 1)]
	assert db.execute('SELECT dataset_id FROM public.dataset_audit WHERE dataset_id = %s', (dataset,)).fetchone()
	assert db.execute('SELECT status FROM public.dataset_flags WHERE id = %s', (flag,)).fetchone() == ('open',)
	assert db.execute('SELECT status FROM public.processing_notification_events WHERE dataset_id = %s', (dataset,)).fetchone() == ('pending',)
	assert db.execute('SELECT id FROM public.priwa_kaeferbaeume WHERE id = %s', (tree,)).fetchone() == (tree,)
	assert db.execute('SELECT status FROM public.prepackaged_dataset_versions WHERE id = %s', (version,)).fetchone() == ('draft',)
	assert db.execute('SELECT validation_count FROM public.prepackaged_dataset_download_grants WHERE id = %s', (grant,)).fetchone() == (0,)
	for role in ('anon', 'authenticated'):
		as_role(db, role)
		db.execute("SELECT set_config('request.jwt.claim.sub', %s, true)", (str(outsider),))
		assert db.execute('SELECT id FROM public.v2_datasets WHERE id = %s', (dataset,)).fetchall() == []
	as_role(db, 'authenticated')
	assert db.execute('SELECT id FROM public.priwa_kaeferbaeume WHERE id = %s', (tree,)).fetchall() == []
	db.execute("SELECT set_config('request.jwt.claim.sub', %s, true)", (str(owner),))
	assert db.execute('SELECT id FROM public.v2_datasets WHERE id = %s', (dataset,)).fetchone() == (dataset,)


@pytest.mark.parametrize('query', [
	'SELECT token_hash FROM public.prepackaged_dataset_download_grants',
	'SELECT requested_ip FROM public.prepackaged_dataset_download_grants',
	'SELECT recipient_email FROM public.processing_notification_events',
	'SELECT status_snapshot FROM public.processing_notification_events',
	'SELECT geom FROM public.priwa_kaeferbaeume',
	'SELECT name FROM public.priwa_kaeferbaeume',
	'SELECT metadata FROM public.v2_metadata',
	'SELECT camera_metadata FROM public.v2_raw_images',
	'SELECT description FROM public.dataset_flags',
	'SELECT notes FROM public.dataset_audit',
	'SELECT authors FROM public.v2_datasets',
	'SELECT * FROM auth.users',
	'SELECT * FROM public.user_info',
	'SELECT * FROM public.processing_notification_events',
	"INSERT INTO public.priwa_projects (slug, name) VALUES ('forbidden', 'forbidden')",
	"UPDATE public.data_publication SET status = 'published' WHERE false",
	'DELETE FROM public.dataset_flags WHERE false',
	'TRUNCATE public.processing_notification_events',
	'SET LOCAL ROLE authenticated',
])
def test_operator_cannot_read_excluded_columns_or_mutate(db, query):
	as_role(db, ROLE)
	# SET ROLE must be tested with session authorization: SET ROLE permission is
	# otherwise checked against the superuser test connection's session identity.
	db.execute(sql.SQL('SET SESSION AUTHORIZATION {}').format(sql.Identifier(ROLE)))
	with pytest.raises(psycopg.errors.InsufficientPrivilege):
		db.execute(query)


def test_every_monitoring_policy_is_select_only_and_columns_are_readable(db):
	assert db.execute('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = %s', (ROLE,)).fetchone() == (False, False)
	policies = db.execute(
		"SELECT tablename, cmd, roles FROM pg_policies WHERE policyname = 'operator_monitoring_read'"
	).fetchall()
	assert len(policies) == 33
	for table, command, roles in policies:
		assert command == 'SELECT' and roles == [ROLE]
		assert db.execute('SELECT relrowsecurity FROM pg_class WHERE oid = %s::regclass', ('public.' + table,)).fetchone()[0]
		columns = db.execute(
			"SELECT column_name FROM information_schema.column_privileges "
			"WHERE grantee = %s AND table_schema = 'public' AND table_name = %s AND privilege_type = 'SELECT'", (ROLE, table)
		).fetchall()
		assert columns
		as_role(db, ROLE)
		db.execute(sql.SQL('SELECT {} FROM public.{} LIMIT 1').format(
			sql.SQL(', ').join(sql.Identifier(column[0]) for column in columns), sql.Identifier(table)
		)).fetchall()
		as_role(db, 'supabase_admin')
		for privilege in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES'):
			assert not db.execute('SELECT has_table_privilege(%s, %s, %s)', (ROLE, 'public.' + table, privilege)).fetchone()[0]
	assert db.execute(
		"SELECT has_table_privilege(%s, 'public.processing_notification_events', 'SELECT'), "
		"has_column_privilege(%s, 'public.processing_notification_events', 'status', 'SELECT')", (ROLE, ROLE)
	).fetchone() == (False, True)
