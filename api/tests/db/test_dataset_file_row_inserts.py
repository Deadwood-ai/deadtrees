"""Dataset rows and their file rows are created only by their owners and the processor (DT-1429)."""

import json
import uuid
from urllib.parse import urlparse

import psycopg
import pytest

from shared.settings import settings

PROCESSOR_EMAIL = 'processor@deadtrees.earth'


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


def as_admin(db):
	db.execute('RESET ROLE')
	db.execute('SELECT set_config(\'request.jwt.claims\',\'{"role":"service_role"}\',true)')


def as_anon(db):
	db.execute('RESET ROLE')
	db.execute('SET LOCAL ROLE anon')
	db.execute('SELECT set_config(\'request.jwt.claims\',\'{"role":"anon"}\',true)')


def act_as(db, user, email=None):
	db.execute('RESET ROLE')
	db.execute('SET LOCAL ROLE authenticated')
	claims = {'sub': str(user), 'role': 'authenticated', **({'email': email} if email else {})}
	db.execute("SELECT set_config('request.jwt.claims',%s,true)", (json.dumps(claims),))


def create_user(db):
	as_admin(db)
	user = uuid.uuid4()
	db.execute('INSERT INTO auth.users(id,email) VALUES (%s,%s)', (user, f'{user}@example.invalid'))
	return user


def create_dataset(db, owner):
	as_admin(db)
	return db.execute(
		'INSERT INTO public.v2_datasets(user_id,file_name,license,platform,data_access) '
		"VALUES (%s,'rows.tif','CC BY','drone','public') RETURNING id",
		(owner,),
	).fetchone()[0]


def expect_denied(db, statement, params=()):
	db.execute('SAVEPOINT denied')
	with pytest.raises(psycopg.errors.InsufficientPrivilege):
		db.execute(statement, params)
	db.execute('ROLLBACK TO SAVEPOINT denied')


INSERT_DATASET = (
	'INSERT INTO public.v2_datasets(user_id,file_name,license,platform,data_access) '
	"VALUES (%s,'mine.tif','CC BY','drone','public') RETURNING id"
)
INSERT_ORTHO = 'INSERT INTO public.v2_orthos(dataset_id,ortho_file_name,version,ortho_file_size) VALUES (%s,%s,1,1)'
INSERT_PROCESSED_ORTHO = (
	'INSERT INTO public.v2_orthos_processed(dataset_id,ortho_file_name,version,ortho_file_size,ortho_processing_runtime) '
	'VALUES (%s,%s,1,1,1)'
)
INSERT_METADATA = "INSERT INTO public.v2_metadata(dataset_id,metadata,version,processing_runtime) VALUES (%s,'{}',1,1)"
INSERT_RAW_IMAGES = (
	'INSERT INTO public.v2_raw_images(dataset_id,raw_image_count,raw_image_size_mb,raw_images_path) VALUES (%s,0,1,%s)'
)


def test_users_create_datasets_only_for_themselves(db):
	user, other = create_user(db), create_user(db)

	as_anon(db)
	expect_denied(db, INSERT_DATASET, (user,))
	act_as(db, user)
	expect_denied(db, INSERT_DATASET, (other,))
	assert db.execute(INSERT_DATASET, (user,)).fetchone()[0]


def test_owners_cannot_point_their_ortho_row_at_another_file(db):
	owner, victim = create_user(db), create_user(db)
	own_dataset, victim_dataset = create_dataset(db, owner), create_dataset(db, victim)

	act_as(db, owner)
	for file_name in ['../../../proc/self/environ', f'{victim_dataset}_ortho.tif', f'{own_dataset}_ortho.tif']:
		expect_denied(db, INSERT_ORTHO, (own_dataset, file_name))
	expect_denied(db, INSERT_PROCESSED_ORTHO, (own_dataset, f'{own_dataset}_ortho.tif'))
	expect_denied(db, INSERT_METADATA, (own_dataset,))


def test_the_processor_creates_ortho_and_metadata_rows(db):
	dataset = create_dataset(db, create_user(db))

	act_as(db, uuid.uuid4(), PROCESSOR_EMAIL)
	db.execute(INSERT_ORTHO, (dataset, f'{dataset}_ortho.tif'))
	db.execute(INSERT_PROCESSED_ORTHO, (dataset, f'{dataset}_ortho.tif'))
	db.execute(INSERT_METADATA, (dataset,))


def test_owners_register_only_their_own_raw_images_zip(db):
	owner, other = create_user(db), create_user(db)
	own_dataset, other_dataset = create_dataset(db, owner), create_dataset(db, other)

	act_as(db, owner)
	for dataset, path in [
		(own_dataset, f'/data/raw_images/{other_dataset}.zip'),
		(own_dataset, f'/data/raw_images/../raw_images/{own_dataset}.zip'),
		(own_dataset, f'/data/archive/{own_dataset}.zip'),
		(own_dataset, '/etc/passwd'),
		(other_dataset, f'/data/raw_images/{other_dataset}.zip'),
	]:
		expect_denied(db, INSERT_RAW_IMAGES, (dataset, path))
	db.execute(INSERT_RAW_IMAGES, (own_dataset, f'/data/raw_images/{own_dataset}.zip'))

	act_as(db, uuid.uuid4(), PROCESSOR_EMAIL)
	db.execute(INSERT_RAW_IMAGES, (other_dataset, f'/data/raw_images/{other_dataset}.zip'))
