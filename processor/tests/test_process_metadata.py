import pytest
from datetime import datetime
from unittest.mock import ANY

from shared.db import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, QueueTask, MetadataType, StatusEnum, Ortho
import processor.src.process_metadata as process_metadata_module


@pytest.fixture
def metadata_dataset_for_processing(auth_token, test_processor_user):
	"""Create only the DB rows metadata processing needs.

	Unlike GeoTIFF/COG/thumbnail stages, metadata processing uses the ortho bbox
	from the database and never pulls the raster from SSH storage.
	"""
	dataset_id = None
	try:
		with use_client(auth_token) as client:
			dataset_data = {
				'file_name': 'test-process.tif',
				'license': 'CC BY',
				'platform': 'drone',
				'authors': ['Test Author'],
				'user_id': test_processor_user,
				'data_access': 'public',
				'aquisition_year': 2024,
				'aquisition_month': 1,
				'aquisition_day': 1,
			}
			response = client.table(settings.datasets_table).insert(dataset_data).execute()
			dataset_id = response.data[0]['id']

			ortho = Ortho(
				dataset_id=dataset_id,
				ortho_file_name=f'{dataset_id}_ortho.tif',
				version=1,
				ortho_file_size=1,
				bbox='BOX(13.4050 52.5200,13.4150 52.5300)',
				ortho_upload_runtime=0.1,
				ortho_info={'Driver': 'GTiff', 'Size': [1024, 1024]},
				created_at=datetime.now(),
			)
			client.table(settings.orthos_table).insert(ortho.model_dump()).execute()

			status_data = {
				'dataset_id': dataset_id,
				'current_status': StatusEnum.idle,
				'is_upload_done': True,
				'is_ortho_done': True,
				'is_cog_done': False,
				'is_thumbnail_done': False,
				'is_deadwood_done': False,
				'is_forest_cover_done': False,
				'is_metadata_done': False,
				'is_audited': False,
				'has_error': False,
			}
			client.table(settings.statuses_table).insert(status_data).execute()

		yield dataset_id
	finally:
		if dataset_id is not None:
			with use_client(auth_token) as client:
				client.table(settings.metadata_table).delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.orthos_table).delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


@pytest.fixture
def metadata_task(metadata_dataset_for_processing, test_processor_user):
	"""Create a test task for metadata processing"""
	return QueueTask(
		id=1,
		dataset_id=metadata_dataset_for_processing,
		user_id=test_processor_user,
		task_types=[TaskTypeEnum.metadata],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
		build_args={},
	)


@pytest.fixture
def suppress_status_updates(monkeypatch):
	"""Record status updates without exercising the DB/RLS path."""
	calls = []

	def record_update_status(*args, **kwargs):
		calls.append({'args': args, 'kwargs': kwargs})

	monkeypatch.setattr(process_metadata_module, 'update_status', record_update_status)
	return calls


def test_process_metadata_success(metadata_task, auth_token, suppress_status_updates):
	"""Test successful metadata processing"""
	process_metadata_module.process_metadata(metadata_task, settings.processing_path)

	with use_client(auth_token) as client:
		response = (
			client.table(settings.metadata_table).select('*').eq('dataset_id', metadata_task.dataset_id).execute()
		)

		assert len(response.data) == 1
		metadata = response.data[0]

		# Verify metadata structure
		assert metadata['dataset_id'] == metadata_task.dataset_id
		assert isinstance(metadata['metadata'], dict)
		assert MetadataType.GADM in metadata['metadata']

		# Verify GADM metadata
		gadm_metadata = metadata['metadata'][MetadataType.GADM]
		assert isinstance(gadm_metadata, dict)
		assert 'admin_level_1' in gadm_metadata
		assert 'admin_level_2' in gadm_metadata
		assert 'admin_level_3' in gadm_metadata
		assert gadm_metadata['source'] == 'GADM'
		assert gadm_metadata['version'] == '4.1.0'

		# Verify biome metadata
		assert MetadataType.BIOME in metadata['metadata']
		biome_metadata = metadata['metadata'][MetadataType.BIOME]
		assert isinstance(biome_metadata, dict)
		assert 'biome_name' in biome_metadata
		assert 'biome_id' in biome_metadata
		assert biome_metadata['source'] == 'WWF Terrestrial Ecoregions'
		assert biome_metadata['version'] == '2.0'

		# Check if phenology metadata was included
		phenology_metadata = metadata['metadata'][MetadataType.PHENOLOGY]
		assert isinstance(phenology_metadata, dict)
		assert 'phenology_curve' in phenology_metadata
		assert len(phenology_metadata['phenology_curve']) == 366
		assert phenology_metadata['source'] == 'MODIS Phenology'
		assert phenology_metadata['version'] == '1.0'

		# Verify other fields
		assert 'version' in metadata
		assert metadata['processing_runtime'] > 0

	assert suppress_status_updates == [
		{
			'args': (ANY, metadata_task.dataset_id),
			'kwargs': {'current_status': StatusEnum.metadata_processing},
		},
		{
			'args': (ANY, metadata_task.dataset_id),
			'kwargs': {'current_status': StatusEnum.idle, 'is_metadata_done': True},
		},
	]
