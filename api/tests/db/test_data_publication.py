import pytest
from shared.db import use_client
from shared.settings import settings
from shared.models import LicenseEnum, PlatformEnum, DatasetAccessEnum


@pytest.fixture(scope='function')
def test_datasets_for_publication(auth_token, test_user):
	"""Create multiple test datasets for publication testing"""
	dataset_ids = []
	publication_ids = []

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
						'is_audited': True,
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
							'is_audited': False,
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
							'is_audited': False,
							'has_error': False,
							'error_message': None,
						}

				client.table(settings.statuses_table).insert(status_data).execute()

			yield dataset_ids

	finally:
		# Improved cleanup to handle foreign key constraints properly
		with use_client(auth_token) as client:
			try:
				# 1. Find all publications that reference these datasets
				all_pubs_query = f"""
					SELECT DISTINCT publication_id 
					FROM jt_data_publication_datasets 
					WHERE dataset_id IN ({','.join([str(id) for id in dataset_ids])})
				"""
				pub_response = client.rpc('exec_sql', {'query': all_pubs_query}).execute()

				if pub_response.data:
					for item in pub_response.data:
						if item and 'publication_id' in item:
							pub_id = item['publication_id']
							publication_ids.append(pub_id)

				# 2. Delete all publications found (cascades to junction tables)
				for pub_id in publication_ids:
					client.table('data_publication').delete().eq('id', pub_id).execute()

				# 3. Delete datasets
				for dataset_id in dataset_ids:
					# Delete all related tables explicitly in proper order
					client.table(settings.metadata_table).delete().eq('dataset_id', dataset_id).execute()
					client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
					client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()

				# 4. Clean up logs
				client.table(settings.logs_table).delete().neq('id', 1).execute()

			except Exception as e:
				print(f'Cleanup error: {e}')


@pytest.fixture(scope='function')
def test_user_info(auth_token, test_user):
	"""Create test user info for publication testing"""
	user_info_id = None

	try:
		with use_client(auth_token) as client:
			user_info_data = {
				'user': test_user,
				'organisation': 'Test Institute',
				'orcid': '0000-0000-0000-0000',
				'first_name': 'Test',
				'last_name': 'User',
				'title': 'Dr.',
			}
			response = client.table('user_info').insert(user_info_data).execute()
			user_info_id = response.data[0]['id']

			yield user_info_id

	finally:
		# Cleanup
		if user_info_id:
			with use_client(auth_token) as client:
				client.table('user_info').delete().eq('id', user_info_id).execute()


def test_create_publication(auth_token, test_datasets_for_publication, test_user_info):
	"""Test creating a new publication with multiple datasets"""
	publication_id = None
	publication_datasets = []
	publication_users = []

	try:
		with use_client(auth_token) as client:
			# Create publication
			publication_data = {
				'title': 'Test Publication',
				'description': 'Test Description',
				'doi': None,  # Initially null, will be updated later
			}
			response = client.table('data_publication').insert(publication_data).execute()
			publication_id = response.data[0]['id']

			# Link datasets to publication (only use first 4 for this test)
			for dataset_id in test_datasets_for_publication[:4]:
				link_data = {'publication_id': publication_id, 'dataset_id': dataset_id}
				client.table('jt_data_publication_datasets').insert(link_data).execute()
				publication_datasets.append(link_data)

			# Link user info to publication
			user_link = {'publication_id': publication_id, 'user_info_id': test_user_info}
			client.table('jt_data_publication_user_info').insert(user_link).execute()
			publication_users.append(user_link)

			# Verify publication was created correctly
			pub_response = client.table('data_publication').select('*').eq('id', publication_id).execute()
			assert len(pub_response.data) == 1
			publication = pub_response.data[0]
			assert publication['title'] == 'Test Publication'
			assert publication['description'] == 'Test Description'
			assert publication['doi'] is None

			# Verify dataset links
			dataset_links = (
				client.table('jt_data_publication_datasets').select('*').eq('publication_id', publication_id).execute()
			)
			assert len(dataset_links.data) == 4  # All 4 datasets should be linked

			# Verify user info link
			user_links = (
				client.table('jt_data_publication_user_info').select('*').eq('publication_id', publication_id).execute()
			)
			assert len(user_links.data) == 1

	finally:
		# Cleanup
		if publication_id:
			with use_client(auth_token) as client:
				# Delete the publication first which will delete the junction table entries due to CASCADE
				client.table('data_publication').delete().eq('id', publication_id).execute()


def test_update_publication_doi(auth_token, test_datasets_for_publication, test_user_info):
	"""Test updating a publication with a DOI"""
	publication_id = None
	publication_datasets = []
	publication_users = []

	try:
		with use_client(auth_token) as client:
			# Create initial publication
			publication_data = {'title': 'Test Publication', 'doi': None}
			response = client.table('data_publication').insert(publication_data).execute()
			publication_id = response.data[0]['id']

			# Link datasets and user info (only use 4 datasets)
			for dataset_id in test_datasets_for_publication[:4]:
				link_data = {'publication_id': publication_id, 'dataset_id': dataset_id}
				client.table('jt_data_publication_datasets').insert(link_data).execute()
				publication_datasets.append(link_data)

			user_link = {'publication_id': publication_id, 'user_info_id': test_user_info}
			client.table('jt_data_publication_user_info').insert(user_link).execute()
			publication_users.append(user_link)

			# Update with DOI
			test_doi = '10.1234/test.123'
			client.table('data_publication').update({'doi': test_doi}).eq('id', publication_id).execute()

			# Verify DOI was updated
			pub_response = client.table('data_publication').select('*').eq('id', publication_id).execute()
			assert len(pub_response.data) == 1
			assert pub_response.data[0]['doi'] == test_doi

	finally:
		# Cleanup
		if publication_id:
			with use_client(auth_token) as client:
				# Delete the publication first which will delete the junction table entries due to CASCADE
				client.table('data_publication').delete().eq('id', publication_id).execute()


def test_publication_with_multiple_authors(auth_token, test_datasets_for_publication):
	"""Test creating a publication with multiple authors"""
	publication_id = None
	user_info_ids = []
	publication_datasets = []
	publication_users = []

	try:
		with use_client(auth_token) as client:
			# Create publication
			publication_data = {'title': 'Multi-Author Publication', 'description': 'Test Description', 'doi': None}
			response = client.table('data_publication').insert(publication_data).execute()
			publication_id = response.data[0]['id']

			# Create multiple authors
			authors = [
				{
					'organisation': 'Institute 1',
					'orcid': '0000-0000-0000-0001',
					'first_name': 'Author',
					'last_name': 'One',
					'title': 'Dr.',
				},
				{
					'organisation': 'Institute 2',
					'orcid': '0000-0000-0000-0002',
					'first_name': 'Author',
					'last_name': 'Two',
					'title': 'Prof.',
				},
			]

			for author in authors:
				response = client.table('user_info').insert(author).execute()
				user_info_ids.append(response.data[0]['id'])

				# Link author to publication
				user_link = {'publication_id': publication_id, 'user_info_id': response.data[0]['id']}
				client.table('jt_data_publication_user_info').insert(user_link).execute()
				publication_users.append(user_link)

			# Link datasets (only use 4 datasets)
			for dataset_id in test_datasets_for_publication[:4]:
				link_data = {'publication_id': publication_id, 'dataset_id': dataset_id}
				client.table('jt_data_publication_datasets').insert(link_data).execute()
				publication_datasets.append(link_data)

			# Verify multiple authors were linked
			user_links = (
				client.table('jt_data_publication_user_info').select('*').eq('publication_id', publication_id).execute()
			)
			assert len(user_links.data) == 2

	finally:
		# Cleanup
		if publication_id:
			with use_client(auth_token) as client:
				# Delete the publication first which will delete the junction table entries due to CASCADE
				client.table('data_publication').delete().eq('id', publication_id).execute()

				# Clean up user info entries
				for user_info_id in user_info_ids:
					client.table('user_info').delete().eq('id', user_info_id).execute()
				# clean up datasets
				for dataset_id in test_datasets_for_publication[:4]:
					client.table('v2_datasets').delete().eq('id', dataset_id).execute()


def test_basic_publication_operations(auth_token, test_datasets_for_publication, test_user_info):
	"""Test basic publication operations to verify schema compatibility"""
	publication_id = None

	try:
		with use_client(auth_token) as client:
			# 1. Create publication
			publication_data = {'title': 'Basic Test Publication', 'doi': None}
			pub_response = client.table('data_publication').insert(publication_data).execute()
			assert len(pub_response.data) == 1
			publication_id = pub_response.data[0]['id']

			# 2. Add one dataset link
			dataset_id = test_datasets_for_publication[0]
			link_response = (
				client.table('jt_data_publication_datasets')
				.insert({'publication_id': publication_id, 'dataset_id': dataset_id})
				.execute()
			)
			assert len(link_response.data) == 1

			# 3. Add user info link
			user_link_response = (
				client.table('jt_data_publication_user_info')
				.insert({'publication_id': publication_id, 'user_info_id': test_user_info})
				.execute()
			)
			assert len(user_link_response.data) == 1

			# 4. Verify data was created
			pub_check = client.table('data_publication').select('*').eq('id', publication_id).execute()
			assert len(pub_check.data) == 1

			dataset_links = (
				client.table('jt_data_publication_datasets').select('*').eq('publication_id', publication_id).execute()
			)
			assert len(dataset_links.data) == 1

			user_links = (
				client.table('jt_data_publication_user_info').select('*').eq('publication_id', publication_id).execute()
			)
			assert len(user_links.data) == 1

	finally:
		# Enhanced cleanup
		if publication_id:
			with use_client(auth_token) as client:
				try:
					# First, remove junction table entries explicitly
					client.table('data_publication').delete().eq('id', publication_id).execute()
					client.table('jt_data_publication_datasets').delete().eq('publication_id', publication_id).execute()
					client.table('jt_data_publication_user_info').delete().eq(
						'publication_id', publication_id
					).execute()

					# Then delete the publication
				except Exception as e:
					print(f'Cleanup error in test_basic_publication_operations: {e}')
