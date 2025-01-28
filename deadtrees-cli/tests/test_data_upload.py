import pytest
from pathlib import Path
from shared.db import use_client
from shared.settings import settings
from shared.models import StatusEnum
from shared.testing.fixtures import test_file, auth_token, cleanup_database, test_processor_user
from deadtrees_cli.data import DataCommands


@pytest.fixture
def data_commands():
	"""Create a DataCommands instance for testing"""
	return DataCommands()


def test_upload_basic(data_commands, test_file):
	"""Test basic file upload with minimal parameters"""
	try:
		result = data_commands.upload(
			file_path=str(test_file),
			authors='Test Author',
			platform='drone',
			data_access='public',
			start_processing=False,
			aquisition_year=2024,
		)

		assert result is not None
		assert 'id' in result
		dataset_id = result['id']

		# Verify dataset was created in database
		token = data_commands._ensure_auth()
		with use_client(token) as client:
			response = client.table(settings.datasets_table).select('*').eq('id', dataset_id).execute()
			assert len(response.data) == 1
			dataset = response.data[0]
			assert dataset['file_name'] == test_file.name

			# Check status
			status_response = client.table(settings.statuses_table).select('*').eq('dataset_id', dataset_id).execute()
			assert len(status_response.data) == 1
			status = status_response.data[0]
			assert status['is_upload_done'] is True
			assert status['current_status'] == StatusEnum.idle.value

	finally:
		# Cleanup
		if 'dataset_id' in locals():
			with use_client(token) as client:
				client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


def test_upload_with_metadata(data_commands, test_file):
	"""Test file upload with full metadata"""
	try:
		result = data_commands.upload(
			file_path=str(test_file),
			authors='Test Author 1, Test Author 2',
			platform='drone',
			data_access='public',
			license='CC BY',
			aquisition_year=2024,
			aquisition_month=1,
			aquisition_day=15,
			additional_information='Test upload with metadata',
			citation_doi='10.5281/zenodo.12345678',
			start_processing=False,
		)

		assert result is not None
		dataset_id = result['id']

		# Verify metadata in database
		token = data_commands._ensure_auth()
		with use_client(token) as client:
			response = client.table(settings.datasets_table).select('*').eq('id', dataset_id).execute()
			dataset = response.data[0]
			assert dataset['authors'] == ['Test Author 1', 'Test Author 2']
			assert dataset['aquisition_year'] == 2024
			assert dataset['citation_doi'] == '10.5281/zenodo.12345678'

	finally:
		# Cleanup
		if 'dataset_id' in locals():
			with use_client(token) as client:
				client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()
