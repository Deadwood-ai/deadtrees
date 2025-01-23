import pytest
from pathlib import Path
from processor.src.utils.admin_levels import get_admin_tags, update_metadata_admin_level
from shared.models import Dataset
from shared.settings import settings
from shared.db import use_client, login
import shutil

# Test data points (real coordinates that exist in GADM data)
TEST_POINTS = [
	# Berlin, Germany
	((13.4050, 52.5200), ['Germany', 'Berlin', 'Berlin']),
	# Paris, France
	((2.3522, 48.8566), ['France', 'Paris', 'Paris, 4e arrondissement']),
	# Invalid point (middle of ocean)
	((0.0, 0.0), [None, None, None]),
]


@pytest.fixture(scope='function')
def test_dataset(auth_token, data_directory, test_geotiff, test_user):
	"""Create a temporary test dataset for admin level testing"""
	with use_client(auth_token) as client:
		# Copy test file to archive directory
		file_name = 'test-admin.tif'
		archive_path = data_directory / settings.ARCHIVE_DIR / file_name
		shutil.copy2(test_geotiff, archive_path)

		# Create test dataset
		dataset_data = {
			'file_name': file_name,
			'file_alias': file_name,
			'file_size': archive_path.stat().st_size,
			'copy_time': 123,
			'user_id': test_user,
			'status': 'uploaded',
		}
		response = client.table(settings.datasets_table).insert(dataset_data).execute()
		dataset_id = response.data[0]['id']

		# Create metadata entry with required fields
		metadata_data = {
			'dataset_id': dataset_id,
			'user_id': test_user,
			'name': 'Test Admin Dataset',
			'platform': 'drone',
			'data_access': 'public',
			'authors': 'Test Author',
		}
		client.table(settings.metadata_table).insert(metadata_data).execute()

		try:
			yield dataset_id
		finally:
			# Cleanup database entries
			client.table(settings.metadata_table).delete().eq('dataset_id', dataset_id).execute()
			client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()
			# Cleanup file
			if archive_path.exists():
				archive_path.unlink()


@pytest.mark.parametrize('point,expected', TEST_POINTS)
def test_get_admin_tags(point, expected):
	"""Test getting administrative tags for various points"""
	result = get_admin_tags(point)
	print(f'Got result: {result}')
	assert result == expected


def test_update_metadata_admin_level(test_dataset, auth_token):
	"""Test updating metadata with admin levels using real database"""
	# Test the function with real database
	result = update_metadata_admin_level(test_dataset, auth_token)

	# Verify the results contain admin level information
	assert 'admin_level_1' in result
	assert 'admin_level_2' in result
	assert 'admin_level_3' in result

	# Verify the data was actually saved to the database
	with use_client(auth_token) as client:
		response = client.table(settings.metadata_table).select('*').eq('dataset_id', test_dataset).execute()

		assert response.data
		metadata = response.data[0]
		assert metadata['admin_level_1'] == result['admin_level_1']
		assert metadata['admin_level_2'] == result['admin_level_2']
		assert metadata['admin_level_3'] == result['admin_level_3']
