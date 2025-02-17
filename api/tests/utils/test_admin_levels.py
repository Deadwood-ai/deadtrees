import pytest
from pathlib import Path
from api.src.utils.admin_levels import get_admin_tags, update_metadata_admin_level
from shared.models import Dataset
from shared.settings import settings
from shared.supabase import use_client, login

# Test data points (real coordinates that exist in GADM data)
TEST_POINTS = [
	# Berlin, Germany
	((13.4050, 52.5200), ['Germany', 'Berlin', 'Berlin']),
	# Paris, France
	((2.3522, 48.8566), ['France', 'Paris', 'Paris, 4e arrondissement']),
	# Invalid point (middle of ocean)
	((0.0, 0.0), [None, None, None]),
]


@pytest.fixture(scope='session')
def test_dataset(auth_token):
	"""Get the test dataset ID from the database.
	Expects a dataset with file_alias = 'test-data.tif' to exist.
	"""
	with use_client(auth_token) as client:
		response = client.table(settings.datasets_table).select('id').eq('file_alias', 'test-data.tif').execute()

		if not response.data:
			pytest.skip('Test dataset not found in database')

		dataset_id = response.data[0]['id']

		yield dataset_id  # Return the dataset ID for the test

		# Cleanup after all tests are done
		client.table(settings.metadata_table).update(
			{'admin_level_1': None, 'admin_level_2': None, 'admin_level_3': None}
		).eq('dataset_id', dataset_id).execute()


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
