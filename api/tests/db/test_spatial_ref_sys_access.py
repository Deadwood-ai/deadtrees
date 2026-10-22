"""Only the database itself may change PostGIS coordinate systems (DT-1441)."""

from urllib.parse import urlparse

import psycopg
import pytest

from shared.settings import settings


@pytest.fixture
def db():
	assert urlparse(settings.SUPABASE_DB_URL).hostname in {'localhost', '127.0.0.1', 'host.docker.internal'}, (
		'Local database required'
	)
	with psycopg.connect(settings.SUPABASE_DB_URL, user='supabase_admin') as connection:
		try:
			yield connection
		finally:
			connection.rollback()


@pytest.mark.parametrize('role', ['anon', 'authenticated'])
def test_users_can_read_coordinate_systems(db, role):
	db.execute(f'SET LOCAL ROLE {role}')
	assert db.execute('SELECT count(*) FROM public.spatial_ref_sys WHERE srid = 4326').fetchone()[0] == 1


@pytest.mark.parametrize('role', ['anon', 'authenticated'])
@pytest.mark.parametrize(
	'statement',
	[
		'DELETE FROM public.spatial_ref_sys WHERE srid = 4326',
		"UPDATE public.spatial_ref_sys SET proj4text = '' WHERE srid = 4326",
		"INSERT INTO public.spatial_ref_sys(srid, auth_name) VALUES (990001, 'test')",
		'TRUNCATE public.spatial_ref_sys',
	],
)
def test_users_cannot_change_coordinate_systems(db, role, statement):
	db.execute(f'SET LOCAL ROLE {role}')
	with pytest.raises(psycopg.errors.InsufficientPrivilege):
		db.execute(statement)
