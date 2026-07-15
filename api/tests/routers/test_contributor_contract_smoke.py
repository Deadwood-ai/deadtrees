from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from api.src.server import app
from api.src.utils.file_utils import UploadType
from shared.db import use_client
from shared.models import DatasetAccessEnum, LicenseEnum, PlatformEnum, StatusEnum
from shared.settings import settings

client = TestClient(app)

GEOTIFF_PROCESSING_STEPS = [
	'geotiff',
	'cog',
	'thumbnail',
	'metadata',
	'aoi_v1',
	'deadwood_v1',
	'treecover_v1',
	'deadwood_treecover_combined_v2',
	'embeddings_v1',
]

RAW_IMAGES_PROCESSING_STEPS = [
	'odm_processing',
	*GEOTIFF_PROCESSING_STEPS,
]


@pytest.fixture(scope='function')
def contributor_dataset(auth_token, test_user):
	dataset_id = None

	try:
		with use_client(auth_token) as supabase_client:
			dataset_response = (
				supabase_client.table(settings.datasets_table)
				.insert(
					{
						'file_name': 'contributor-contract-smoke.tif',
						'user_id': test_user,
						'license': LicenseEnum.cc_by.value,
						'platform': PlatformEnum.drone.value,
						'authors': ['Contract Smoke Contributor'],
						'data_access': DatasetAccessEnum.public.value,
						'aquisition_year': 2024,
						'aquisition_month': 5,
						'aquisition_day': 6,
					}
				)
				.execute()
			)
			dataset_id = dataset_response.data[0]['id']
			supabase_client.table(settings.statuses_table).insert(
				{
					'dataset_id': dataset_id,
					'is_upload_done': True,
					'current_status': StatusEnum.idle.value,
				}
			).execute()

		yield dataset_id

	finally:
		if dataset_id:
			with use_client(auth_token) as supabase_client:
				supabase_client.table(settings.queue_table).delete().eq('dataset_id', dataset_id).execute()
				supabase_client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
				supabase_client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


@pytest.mark.parametrize(
	('upload_type', 'filename', 'expected_tmp_parent'),
	[
		(UploadType.GEOTIFF.value, 'contributor-smoke.tif', 'archive_path'),
		(UploadType.RAW_IMAGES_ZIP.value, 'contributor-smoke.zip', 'raw_images_path'),
	],
)
def test_contributor_chunk_upload_contract_targets_expected_storage(
	auth_token,
	data_directory,
	upload_type,
	filename,
	expected_tmp_parent,
):
	upload_id = f'contributor-contract-{uuid4()}'
	expected_tmp_path = getattr(settings, expected_tmp_parent) / f'{upload_id}.tmp'

	try:
		response = client.post(
			'/datasets/chunk',
			files={'file': (filename, b'partial upload bytes', 'application/octet-stream')},
			data={
				'chunk_index': '0',
				'chunks_total': '2',
				'upload_id': upload_id,
				'license': LicenseEnum.cc_by.value,
				'platform': PlatformEnum.drone.value,
				'authors': ['Contract Smoke Contributor', 'Second Contributor'],
				'data_access': DatasetAccessEnum.public.value,
				'upload_type': upload_type,
				'aquisition_year': '2024',
				'aquisition_month': '5',
				'aquisition_day': '6',
				'additional_information': 'Contributor contract smoke',
				'citation_doi': 'https://doi.org/10.1234/deadtrees.contract-smoke',
			},
			headers={'Authorization': f'Bearer {auth_token}'},
		)

		assert response.status_code == 200
		assert response.json() == {'message': 'Chunk 0 of 2 received'}
		assert expected_tmp_path.exists()
		assert expected_tmp_path.read_bytes() == b'partial upload bytes'

	finally:
		expected_tmp_path.unlink(missing_ok=True)


@pytest.mark.parametrize(
	('processing_steps', 'expected_steps'),
	[
		(GEOTIFF_PROCESSING_STEPS, GEOTIFF_PROCESSING_STEPS),
		(RAW_IMAGES_PROCESSING_STEPS, RAW_IMAGES_PROCESSING_STEPS),
	],
)
def test_contributor_processing_contract_enqueues_frontend_steps(
	contributor_dataset,
	auth_token,
	processing_steps,
	expected_steps,
):
	response = client.put(
		f'/datasets/{contributor_dataset}/process',
		headers={'Authorization': f'Bearer {auth_token}'},
		json={'task_types': processing_steps, 'priority': 4},
	)

	assert response.status_code == 200
	body = response.json()
	assert body['dataset_id'] == contributor_dataset
	assert body['task_types'] == expected_steps
	assert body['priority'] == 4
	assert body['is_processing'] is False

	with use_client(auth_token) as supabase_client:
		queue_response = (
			supabase_client.table(settings.queue_table)
			.select('dataset_id,task_types,priority,is_processing')
			.eq('dataset_id', contributor_dataset)
			.execute()
		)

	assert queue_response.data == [
		{
			'dataset_id': contributor_dataset,
			'task_types': expected_steps,
			'priority': 4,
			'is_processing': False,
		}
	]
