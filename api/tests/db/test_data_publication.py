import pytest
from postgrest.exceptions import APIError
from shared.db import use_client, use_service_client
from shared.settings import settings
from shared.models import LicenseEnum, PlatformEnum, DatasetAccessEnum


@pytest.fixture(scope='function')
def test_datasets_for_publication(auth_token, test_user):
	"""Create multiple test datasets for publication testing"""
	dataset_ids = []
	audit_rows = []

	try:
		with use_client(auth_token) as client:
			# Create 10 test datasets
			for i in range(10):
				dataset_data = {
					'file_name': f'test-publication-{i}.tif',
					'user_id': test_user,
					'license': LicenseEnum.cc_by,
					'platform': PlatformEnum.drone,
					'authors': ['Test Author'],
					'data_access': DatasetAccessEnum.public,
					'citation_doi': '10.5281/zenodo.15470294'
					if i % 2 == 0
					else None,  # DOI only for even-indexed datasets
					'aquisition_year': 2024,
					'aquisition_month': 1,
					'aquisition_day': 1,
				}
				response = client.table(settings.datasets_table).insert(dataset_data).execute()
				dataset_id = response.data[0]['id']
				dataset_ids.append(dataset_id)

				# Create metadata entry for each dataset
				metadata_data = {
					'dataset_id': dataset_id,
					'metadata': {
						'gadm': {
							'source': 'GADM',
							'version': '4.1.0',
							'admin_level_1': 'Brazil',
							'admin_level_2': 'Frederico Westphalen',
							'admin_level_3': '',
						},
						'biome': {
							'source': 'WWF Terrestrial Ecoregions',
							'version': '2.0',
							'biome_id': 1,
							'biome_name': 'Tropical and Subtropical Moist Broadleaf Forests',
						},
					},
					'version': 1,
					'processing_runtime': 0.5,
				}
				client.table(settings.metadata_table).insert(metadata_data).execute()

				# Create status entry for each dataset
				if i % 2 == 0:
					# For even-indexed datasets, set all processing steps to true
					status_data = {
						'dataset_id': dataset_id,
						'current_status': 'idle',
						'is_upload_done': True,
						'is_ortho_done': True,
						'is_cog_done': True,
						'is_thumbnail_done': True,
						'is_deadwood_done': True,
						'is_forest_cover_done': True,
						'is_metadata_done': True,
						'has_error': False,
						'error_message': None,
					}
				else:
					# For odd-indexed datasets, create varied combinations
					if i % 4 == 1:
						# First odd dataset: partially processed with error
						status_data = {
							'dataset_id': dataset_id,
							'current_status': 'idle',
							'is_upload_done': True,
							'is_ortho_done': True,
							'is_cog_done': False,
							'is_thumbnail_done': False,
							'is_deadwood_done': False,
							'is_forest_cover_done': False,
							'is_metadata_done': True,
							'has_error': True,
							'error_message': 'Error during COG processing',
						}
					else:
						# Second odd dataset: different partial processing
						status_data = {
							'dataset_id': dataset_id,
							'current_status': 'idle',
							'is_upload_done': True,
							'is_ortho_done': True,
							'is_cog_done': True,
							'is_thumbnail_done': True,
							'is_deadwood_done': False,
							'is_forest_cover_done': False,
							'is_metadata_done': True,
							'has_error': False,
							'error_message': None,
						}

				client.table(settings.statuses_table).insert(status_data).execute()
				if i % 2 == 0:
					audit_rows.append(
						{
							'dataset_id': dataset_id,
							'is_georeferenced': True,
							'has_valid_acquisition_date': True,
							'has_valid_phenology': True,
							'deadwood_quality': 'sentinel_ok',
							'forest_cover_quality': 'great',
							'aoi_done': True,
							'has_cog_issue': False,
							'has_thumbnail_issue': False,
							'audited_by': test_user,
							'has_major_issue': False,
							'final_assessment': 'ready',
						}
					)

			with use_service_client() as service_client:
				service_client.table('dataset_audit').insert(audit_rows).execute()

			yield dataset_ids

	finally:
		# Deleting a publication cascades to its links. Users cannot delete
		# publications, so cleanup runs as the service role.
		with use_service_client() as service_client:
			links = (
				service_client.table('jt_data_publication_datasets')
				.select('publication_id')
				.in_('dataset_id', dataset_ids)
				.execute()
			)
			for publication_id in {link['publication_id'] for link in links.data}:
				service_client.table('data_publication').delete().eq('id', publication_id).execute()
			for dataset_id in dataset_ids:
				service_client.table('dataset_audit').delete().eq('dataset_id', dataset_id).execute()
				service_client.table(settings.metadata_table).delete().eq('dataset_id', dataset_id).execute()
				service_client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
				service_client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


def author(test_user, last_name='User'):
	return {
		'user': test_user,
		'organisation': 'Test Institute',
		'orcid': '0000-0000-0000-0000',
		'first_name': 'Test',
		'last_name': last_name,
		'title': 'Dr.',
	}


def delete_authors(user_info_ids):
	with use_service_client() as service_client:
		for user_info_id in user_info_ids:
			service_client.table('jt_data_publication_user_info').delete().eq('user_info_id', user_info_id).execute()
			service_client.table('user_info').delete().eq('id', user_info_id).execute()


@pytest.fixture(scope='function')
def test_user_info(auth_token, test_user):
	"""An author record created by the signed-in user, as PublicationModal does."""
	with use_client(auth_token) as client:
		user_info_id = client.table('user_info').insert(author(test_user)).execute().data[0]['id']
	try:
		yield user_info_id
	finally:
		delete_authors([user_info_id])


def create_publication(client, test_user, **fields):
	publication = {'title': 'Test Publication', 'description': 'Test Description', 'user_id': test_user, **fields}
	return client.table('data_publication').insert(publication).execute().data[0]['id']


def test_create_publication(auth_token, test_user, test_datasets_for_publication, test_user_info):
	"""A user creates a pending publication for their datasets, as PublicationModal does."""
	with use_client(auth_token) as client:
		publication_id = create_publication(client, test_user)
		for dataset_id in test_datasets_for_publication[:4]:
			client.table('jt_data_publication_datasets').insert(
				{'publication_id': publication_id, 'dataset_id': dataset_id}
			).execute()
		client.table('jt_data_publication_user_info').insert(
			{'publication_id': publication_id, 'user_info_id': test_user_info}
		).execute()

		publication = client.table('data_publication').select('*').eq('id', publication_id).execute().data
		assert len(publication) == 1
		assert publication[0]['title'] == 'Test Publication'
		assert publication[0]['status'] == 'pending'
		assert publication[0]['doi'] is None
		dataset_links = (
			client.table('jt_data_publication_datasets').select('*').eq('publication_id', publication_id).execute()
		)
		assert len(dataset_links.data) == 4
		user_links = (
			client.table('jt_data_publication_user_info').select('*').eq('publication_id', publication_id).execute()
		)
		assert len(user_links.data) == 1


def test_doi_is_written_by_the_service_role_only(auth_token, test_user, test_datasets_for_publication):
	"""DOIs are minted by the FreiDATA sync, never set by the publishing user."""
	with use_client(auth_token) as client:
		with pytest.raises(APIError):
			create_publication(client, test_user, doi='10.1234/forged')
		publication_id = create_publication(client, test_user)
		client.table('jt_data_publication_datasets').insert(
			{'publication_id': publication_id, 'dataset_id': test_datasets_for_publication[0]}
		).execute()
		with pytest.raises(APIError):
			client.table('data_publication').update({'doi': '10.1234/forged'}).eq('id', publication_id).execute()
		with pytest.raises(APIError):
			client.table('data_publication').delete().eq('id', publication_id).execute()

	with use_service_client() as service_client:
		service_client.table('data_publication').update({'doi': '10.1234/test.123'}).eq('id', publication_id).execute()

	with use_client(auth_token) as client:
		publication = client.table('data_publication').select('doi').eq('id', publication_id).execute().data
		assert publication == [{'doi': '10.1234/test.123'}]


def test_publication_with_multiple_authors(auth_token, test_user, test_datasets_for_publication):
	user_info_ids = []
	try:
		with use_client(auth_token) as client:
			publication_id = create_publication(client, test_user, title='Multi-Author Publication')
			for last_name in ('One', 'Two'):
				user_info_id = client.table('user_info').insert(author(test_user, last_name)).execute().data[0]['id']
				user_info_ids.append(user_info_id)
				client.table('jt_data_publication_user_info').insert(
					{'publication_id': publication_id, 'user_info_id': user_info_id}
				).execute()
			for dataset_id in test_datasets_for_publication[:4]:
				client.table('jt_data_publication_datasets').insert(
					{'publication_id': publication_id, 'dataset_id': dataset_id}
				).execute()

			user_links = (
				client.table('jt_data_publication_user_info').select('*').eq('publication_id', publication_id).execute()
			)
			assert len(user_links.data) == 2
	finally:
		delete_authors(user_info_ids)
