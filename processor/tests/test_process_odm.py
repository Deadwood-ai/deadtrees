import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock

from shared.db import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, QueueTask, StatusEnum
from processor.src.process_odm import process_odm
from processor.src.utils.ssh import push_file_to_storage_server, check_file_exists_on_storage


@pytest.fixture
def test_zip_file():
	"""Get path to test ZIP file for ODM processing"""
	# Try multiple possible paths for the test file
	possible_paths = [
		Path(settings.base_path) / 'assets' / 'test_data' / 'raw_drone_images' / 'test_no_rtk_3_images.zip',
		Path('/app/assets/test_data/raw_drone_images/test_no_rtk_3_images.zip'),
		Path('./assets/test_data/raw_drone_images/test_no_rtk_3_images.zip'),
	]

	for zip_path in possible_paths:
		if zip_path.exists():
			return zip_path

	pytest.skip(
		f'Test ZIP file not found at any of {possible_paths}. Run `./scripts/create_odm_test_data.sh` to create test data.'
	)
	return None


@pytest.fixture
def odm_test_dataset(auth_token, test_zip_file, test_processor_user):
	"""Create a test dataset for ODM processing with uploaded ZIP file"""
	dataset_id = None

	try:
		# Create test dataset in database (ZIP upload)
		with use_client(auth_token) as client:
			dataset_data = {
				'file_name': 'test_no_rtk_3_images.zip',
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

			# Upload ZIP file to storage (simulating upload completion)
			zip_filename = f'{dataset_id}.zip'
			remote_zip_path = f'{settings.raw_images_path}/{zip_filename}'
			push_file_to_storage_server(str(test_zip_file), remote_zip_path, auth_token, dataset_id)

			# Create raw_images entry
			raw_images_data = {
				'dataset_id': dataset_id,
				'version': 1,
				'raw_image_count': 3,
				'raw_image_size_mb': int(test_zip_file.stat().st_size / 1024 / 1024),  # MB
				'raw_images_path': remote_zip_path,
				'camera_metadata': {},
				'has_rtk_data': False,
				'rtk_precision_cm': None,
				'rtk_quality_indicator': None,
				'rtk_file_count': 0,
			}
			client.table(settings.raw_images_table).insert(raw_images_data).execute()

			# Create status entry
			status_data = {
				'dataset_id': dataset_id,
				'current_status': StatusEnum.idle,
				'is_upload_done': True,
				'is_odm_done': False,  # ODM not yet processed
				'is_ortho_done': False,
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
		# Cleanup
		if dataset_id:
			with use_client(auth_token) as client:
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()
				client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.raw_images_table).delete().eq('dataset_id', dataset_id).execute()


@pytest.fixture
def odm_task(odm_test_dataset, test_processor_user):
	"""Create a test task for ODM processing"""
	return QueueTask(
		id=1,
		dataset_id=odm_test_dataset,
		user_id=test_processor_user,
		task_types=[TaskTypeEnum.odm_processing],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
		build_args={},
	)


@pytest.mark.slow
def test_odm_container_execution_with_minimal_images(odm_task, auth_token):
	"""Test ODM container execution with minimal image set (mocked for speed)"""

	# Mock Docker client and container execution for faster testing
	with patch('processor.src.process_odm.docker.from_env') as mock_docker:
		mock_client = MagicMock()
		mock_docker.return_value = mock_client

		# Mock successful container run
		mock_client.containers.run.return_value = None

		# Mock orthomosaic creation
		with patch('processor.src.process_odm._find_orthomosaic') as mock_find_ortho:
			mock_ortho_path = Path(settings.processing_path) / 'mock_orthomosaic.tif'
			mock_ortho_path.parent.mkdir(parents=True, exist_ok=True)
			mock_ortho_path.touch()  # Create mock file
			mock_find_ortho.return_value = mock_ortho_path

			# Mock SSH operations
			with patch('processor.src.process_odm.push_file_to_storage_server') as mock_push:
				# Execute ODM processing
				process_odm(odm_task, Path(settings.processing_path))

				# Verify Docker container was called with correct parameters
				mock_client.containers.run.assert_called_once()
				call_args = mock_client.containers.run.call_args[1]

				# Verify container configuration
				assert call_args['image'] == 'opendronemap/odm'
				assert '/code/images' in call_args['volumes']
				assert '/code/odm_output' in call_args['volumes']
				assert call_args['remove'] is True

				# Verify ODM command parameters
				command = call_args['command']
				assert '--project-path' in command
				assert '--orthophoto-resolution' in command
				assert '--feature-quality' in command

				# Verify orthomosaic was pushed to storage
				mock_push.assert_called_once()
				push_args = mock_push.call_args[1]
				assert push_args['remote_file_path'].endswith(f'{odm_task.dataset_id}_ortho.tif')

				# Verify status was updated
				with use_client(auth_token) as client:
					status_response = (
						client.table(settings.statuses_table)
						.select('*')
						.eq('dataset_id', odm_task.dataset_id)
						.execute()
					)
					assert status_response.data[0]['is_odm_done'] is True


def test_odm_orthomosaic_generation_and_storage(odm_task, auth_token):
	"""Test that ODM generates orthomosaic and moves it to correct archive location"""

	# Mock the entire ODM processing pipeline
	with patch('processor.src.process_odm.docker.from_env') as mock_docker:
		mock_client = MagicMock()
		mock_docker.return_value = mock_client
		mock_client.containers.run.return_value = None

		# Mock orthomosaic creation
		with patch('processor.src.process_odm._find_orthomosaic') as mock_find_ortho:
			mock_ortho_path = Path(settings.processing_path) / 'odm_output' / 'odm_orthophoto' / 'odm_orthophoto.tif'
			mock_ortho_path.parent.mkdir(parents=True, exist_ok=True)
			mock_ortho_path.touch()
			mock_find_ortho.return_value = mock_ortho_path

			# Track push operations
			pushed_files = []

			def mock_push_file(local_path, remote_path, token, dataset_id):
				pushed_files.append({'local': local_path, 'remote': remote_path, 'dataset_id': dataset_id})

			with patch('processor.src.process_odm.push_file_to_storage_server', side_effect=mock_push_file):
				# Execute ODM processing
				process_odm(odm_task, Path(settings.processing_path))

				# Verify orthomosaic was pushed to correct location
				assert len(pushed_files) == 1
				push_info = pushed_files[0]

				# Verify remote path follows archive naming convention
				expected_remote_path = f'{settings.archive_path}/{odm_task.dataset_id}_ortho.tif'
				assert push_info['remote'] == expected_remote_path
				assert push_info['dataset_id'] == odm_task.dataset_id

				# Verify local path points to found orthomosaic
				assert push_info['local'] == str(mock_ortho_path)


def test_odm_status_tracking_updates(odm_task, auth_token):
	"""Test that ODM processing correctly updates status tracking"""

	# Mock ODM processing
	with patch('processor.src.process_odm.docker.from_env') as mock_docker:
		mock_client = MagicMock()
		mock_docker.return_value = mock_client
		mock_client.containers.run.return_value = None

		with patch('processor.src.process_odm._find_orthomosaic') as mock_find_ortho:
			mock_ortho_path = Path(settings.processing_path) / 'mock_orthomosaic.tif'
			mock_ortho_path.parent.mkdir(parents=True, exist_ok=True)
			mock_ortho_path.touch()
			mock_find_ortho.return_value = mock_ortho_path

			with patch('processor.src.process_odm.push_file_to_storage_server'):
				# Check initial status
				with use_client(auth_token) as client:
					initial_status = (
						client.table(settings.statuses_table)
						.select('*')
						.eq('dataset_id', odm_task.dataset_id)
						.execute()
					).data[0]
					assert initial_status['is_odm_done'] is False
					assert initial_status['is_upload_done'] is True

				# Execute ODM processing
				process_odm(odm_task, Path(settings.processing_path))

				# Check final status
				with use_client(auth_token) as client:
					final_status = (
						client.table(settings.statuses_table)
						.select('*')
						.eq('dataset_id', odm_task.dataset_id)
						.execute()
					).data[0]

					# Verify ODM completion
					assert final_status['is_odm_done'] is True

					# Verify other statuses preserved
					assert final_status['is_upload_done'] is True
					assert final_status['is_ortho_done'] is False  # Not yet processed by geotiff
					assert final_status['has_error'] is False


def test_odm_error_handling_missing_orthomosaic(odm_task, auth_token):
	"""Test ODM error handling when no orthomosaic is generated"""

	with patch('processor.src.process_odm.docker.from_env') as mock_docker:
		mock_client = MagicMock()
		mock_docker.return_value = mock_client
		mock_client.containers.run.return_value = None

		# Mock missing orthomosaic
		with patch('processor.src.process_odm._find_orthomosaic', return_value=None):
			# ODM processing should raise exception
			with pytest.raises(Exception, match='ODM did not generate an orthomosaic'):
				process_odm(odm_task, Path(settings.processing_path))


def test_odm_error_handling_container_failure(odm_task, auth_token):
	"""Test ODM error handling when Docker container fails"""

	with patch('processor.src.process_odm.docker.from_env') as mock_docker:
		mock_client = MagicMock()
		mock_docker.return_value = mock_client

		# Mock container failure
		from docker.errors import ContainerError

		mock_error = ContainerError(
			container=MagicMock(),
			exit_status=1,
			command='odm',
			image='opendronemap/odm',
			stderr=b'ODM processing failed: insufficient images',
		)
		mock_client.containers.run.side_effect = mock_error

		# ODM processing should raise exception with helpful message
		with pytest.raises(Exception, match='ODM processing failed: insufficient images'):
			process_odm(odm_task, Path(settings.processing_path))
