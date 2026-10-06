"""Uploads of a file that is already on the platform are rejected.

Runs through the real API, local database and storage. The rule is the database
function find_duplicate_upload (20261006140000_duplicate_upload_detection.sql).
"""

from io import BytesIO
from uuid import uuid4
from zipfile import ZipFile

import pytest
from fastapi.testclient import TestClient

from api.src.server import app
from shared.db import use_client, use_service_client
from shared.hash import get_file_identifier
from shared.settings import settings


@pytest.fixture
def upload(auth_token, data_directory, monkeypatch):
	"""Send a whole file as one upload, as the processor account unless a token is given."""
	# These tests use arbitrary bytes; the GeoTIFF content check has its own tests.
	monkeypatch.setattr('api.src.routers.upload.ensure_georeferenced_geotiff', lambda _path: None)

	def send(content, filename='duplicate.tif', token=auth_token, upload_id=None, **metadata):
		with TestClient(app) as client:
			return client.post(
				'/datasets/chunk',
				files={'file': (filename, content, 'application/octet-stream')},
				data={
					'upload_id': upload_id or f'duplicate-{uuid4()}',
					'chunk_index': 0,
					'chunks_total': 1,
					'license': 'CC BY',
					'platform': 'drone',
					'authors': ['Duplicate test'],
					**metadata,
				},
				headers={'Authorization': f'Bearer {token}'},
			)

	return send


def _unique_file(filename: str) -> bytes:
	marker = f'unique upload {uuid4()}'.encode()
	if not filename.endswith('.zip'):
		return marker
	buffer = BytesIO()
	with ZipFile(buffer, 'w') as archive:
		for index in range(3):
			archive.writestr(f'DJI_000{index}.JPG', marker)
	return buffer.getvalue()


def _dataset_ids(file_name: str) -> list[int]:
	with use_service_client() as db:
		rows = db.table(settings.datasets_table).select('id').eq('file_name', file_name).execute().data
	return [row['id'] for row in rows]


@pytest.mark.parametrize('extension', ['tif', 'zip'])
def test_same_file_is_rejected_and_names_the_existing_dataset(upload, extension):
	filename = f'{uuid4()}.{extension}'
	content = _unique_file(filename)
	first = upload(content, filename=filename)
	assert first.status_code == 200, first.text
	dataset_id = first.json()['id']

	second_upload_id = f'duplicate-{uuid4()}'
	for _ in range(2):  # a retry of the rejected upload gets the same answer
		second = upload(content, filename=filename, upload_id=second_upload_id)
		assert second.status_code == 409, second.text
		detail = second.json()['detail']
		assert detail['code'] == 'DUPLICATE_UPLOAD'
		assert detail['existing_dataset_id'] == dataset_id
		assert f'dataset {dataset_id}' in detail['message']
		assert 'info@deadtrees.earth' in detail['message']
	assert _dataset_ids(filename) == [dataset_id]


def test_explicit_override_uploads_a_duplicate_as_a_new_dataset(upload):
	filename = f'{uuid4()}.tif'
	content = _unique_file(filename)
	first = upload(content, filename=filename).json()

	forced = upload(content, filename=filename, allow_duplicate='true')

	assert forced.status_code == 200, forced.text
	assert forced.json()['id'] != first['id']
	assert forced.json()['upload_fingerprint'] == first['upload_fingerprint']
	assert sorted(_dataset_ids(filename)) == sorted([first['id'], forced.json()['id']])


def test_upload_stores_the_fingerprint_of_the_uploaded_file(upload, tmp_path):
	filename = f'{uuid4()}.tif'
	content = _unique_file(filename)
	(tmp_path / filename).write_bytes(content)

	dataset = upload(content, filename=filename).json()

	assert dataset['upload_fingerprint'] == get_file_identifier(tmp_path / filename)


def test_archived_dataset_does_not_block_a_new_upload(upload):
	filename = f'{uuid4()}.tif'
	content = _unique_file(filename)
	first = upload(content, filename=filename).json()
	with use_service_client() as db:
		db.table(settings.datasets_table).update({'archived': True}).eq('id', first['id']).execute()

	second = upload(content, filename=filename)

	assert second.status_code == 200, second.text
	assert second.json()['id'] != first['id']


def test_failed_dataset_still_blocks(upload, auth_token):
	filename = f'{uuid4()}.tif'
	content = _unique_file(filename)
	first = upload(content, filename=filename).json()
	with use_client(auth_token) as db:
		db.table(settings.statuses_table).update({'has_error': True, 'error_message': 'failed'}).eq(
			'dataset_id', first['id']
		).execute()

	assert upload(content, filename=filename).status_code == 409


def test_file_matching_a_processed_orthomosaic_is_rejected(upload, auth_token, test_processor_user, tmp_path):
	"""Covers datasets from before fingerprints were stored at upload, and re-uploads of ODM results."""
	filename = f'{uuid4()}.tif'
	content = _unique_file(filename)
	(tmp_path / filename).write_bytes(content)
	with use_client(auth_token) as db:
		dataset_id = (
			db.table(settings.datasets_table)
			.insert(
				{
					'file_name': filename,
					'user_id': test_processor_user,
					'license': 'CC BY',
					'platform': 'drone',
					'authors': ['Duplicate test'],
					'data_access': 'public',
				}
			)
			.execute()
			.data[0]['id']
		)
		db.table(settings.orthos_table).insert(
			{
				'dataset_id': dataset_id,
				'ortho_file_name': filename,
				'version': 1,
				'ortho_file_size': 1,
				'sha256': get_file_identifier(tmp_path / filename),
			}
		).execute()

	response = upload(content, filename=filename)

	assert response.status_code == 409, response.text
	assert response.json()['detail']['existing_dataset_id'] == dataset_id


def test_private_dataset_of_another_user_blocks_without_being_named(upload, access_accounts):
	filename = f'{uuid4()}.tif'
	content = _unique_file(filename)
	owner, stranger = access_accounts['owner'], access_accounts['stranger']
	first = upload(content, filename=filename, token=owner['token'], data_access='private')
	assert first.status_code == 200, first.text
	dataset_id = first.json()['id']

	own_retry = upload(content, filename=filename, token=owner['token'])
	assert own_retry.json()['detail']['existing_dataset_id'] == dataset_id

	response = upload(content, filename=filename, token=stranger['token'])

	assert response.status_code == 409, response.text
	detail = response.json()['detail']
	assert detail['code'] == 'DUPLICATE_UPLOAD'
	assert detail['existing_dataset_id'] is None
	assert str(dataset_id) not in response.text
	assert _dataset_ids(filename) == [dataset_id]


def test_anonymous_callers_cannot_probe_for_files(upload):
	from postgrest.exceptions import APIError

	from shared.db import use_anon_client

	with use_anon_client() as db, pytest.raises(APIError):
		db.rpc('find_duplicate_upload', {'p_fingerprint': 'a' * 64}).execute()
