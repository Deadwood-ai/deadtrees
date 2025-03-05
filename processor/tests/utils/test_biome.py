import pytest
from processor.src.utils.biome import get_biome_data
from shared.db import use_client
from shared.settings import settings
from shared.models import MetadataType, TaskTypeEnum, QueueTask
from processor.src.process_metadata import process_metadata
from shared.testing.fixtures import auth_token

# Test data points (real coordinates with known biomes)
TEST_POINTS = [
	# Amazon rainforest
	((-63.0, -3.0), ('Tropical and Subtropical Moist Broadleaf Forests', 1)),
	# Sahara desert
	((2.0, 25.0), ('Deserts and Xeric Shrublands', 13)),
	# Invalid point (middle of ocean)
	((0.0, 0.0), (None, None)),
]


@pytest.fixture
def metadata_task(test_dataset_for_processing):
	"""Create a metadata task"""
	return QueueTask(
		id=1,
		dataset_id=test_dataset_for_processing,
		user_id='test',
		task_types=[TaskTypeEnum.metadata],
		priority=1,
		is_processing=False,
		current_position=0,
	)


@pytest.mark.parametrize('point,expected', TEST_POINTS)
def test_get_biome_data(point, expected):
	"""Test biome data retrieval for various points"""
	biome_name, biome_id = get_biome_data(point)
	assert (biome_name, biome_id) == expected


def test_process_metadata_biome(metadata_task, auth_token):
	"""Test biome metadata processing"""
	process_metadata(metadata_task, settings.processing_path)

	with use_client(auth_token) as client:
		response = (
			client.table(settings.metadata_table).select('*').eq('dataset_id', metadata_task.dataset_id).execute()
		)

		metadata = response.data[0]
		assert MetadataType.BIOME in metadata['metadata']

		biome_metadata = metadata['metadata'][MetadataType.BIOME]
		assert isinstance(biome_metadata, dict)
		assert 'biome_name' in biome_metadata
		assert 'biome_id' in biome_metadata
		assert biome_metadata['source'] == 'WWF Terrestrial Ecoregions'
		assert biome_metadata['version'] == '2.0'
