import pytest
from processor.src.utils.admin_levels import get_admin_tags
from shared.settings import settings
from shared.db import use_client
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
			'license': 'CC BY',
			'platform': 'drone',
			'authors': ['Test Author'],
			'user_id': test_user,
			'data_access': 'public',
		}
		response = client.table(settings.datasets_table).insert(dataset_data).execute()
		dataset_id = response.data[0]['id']

		# Create ortho entry
		ortho_data = {
			'dataset_id': dataset_id,
			'ortho_file_name': file_name,
			'version': 1,
			'file_size': archive_path.stat().st_size,
			'ortho_processed': True,
			'ortho_processing_runtime': 0.1,
		}
		client.table(settings.orthos_table).insert(ortho_data).execute()

		# Create initial metadata entry
		metadata_data = {
			'dataset_id': dataset_id,
			'metadata': {},
			'version': 1,
		}
		client.table(settings.metadata_table).insert(metadata_data).execute()

		try:
			yield dataset_id
		finally:
			# Cleanup database entries
			client.table(settings.metadata_table).delete().eq('dataset_id', dataset_id).execute()
			client.table(settings.orthos_table).delete().eq('dataset_id', dataset_id).execute()
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
