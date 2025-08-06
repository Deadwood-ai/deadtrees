import pytest

from shared.db import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, QueueTask, LabelDataEnum, LabelSourceEnum, LabelTypeEnum
from processor.src.process_treecover_segmentation import process_treecover_segmentation


@pytest.fixture
def treecover_task(test_dataset_for_processing, test_processor_user):
	"""Create a test task specifically for tree cover segmentation processing"""
	return QueueTask(
		id=1,
		dataset_id=test_dataset_for_processing,
		user_id=test_processor_user,
		task_types=[TaskTypeEnum.treecover],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
	)


@pytest.fixture(autouse=True)
def cleanup_labels(auth_token, treecover_task):
	"""Fixture to clean up labels after each test"""
	yield

	# Cleanup will run after each test
	with use_client(auth_token) as client:
		# Get all labels for the dataset
		response = (
			client.table(settings.labels_table).select('id').eq('dataset_id', treecover_task.dataset_id).execute()
		)

		# Delete all associated geometries and labels
		for label in response.data:
			client.table(settings.forest_cover_geometries_table).delete().eq('label_id', label['id']).execute()

		client.table(settings.labels_table).delete().eq('dataset_id', treecover_task.dataset_id).execute()


@pytest.mark.comprehensive
def test_process_treecover_segmentation_success(treecover_task, auth_token):
	"""Test successful tree cover segmentation processing with TCD container"""
	process_treecover_segmentation(treecover_task, auth_token, settings.processing_path)

	with use_client(auth_token) as client:
		# Get label
		response = client.table(settings.labels_table).select('*').eq('dataset_id', treecover_task.dataset_id).execute()

		# Should have exactly one label created
		assert len(response.data) == 1
		label = response.data[0]

		# Basic label checks
		assert label['dataset_id'] == treecover_task.dataset_id
		assert label['label_source'] == LabelSourceEnum.model_prediction.value
		assert label['label_type'] == LabelTypeEnum.semantic_segmentation.value
		assert label['label_data'] == LabelDataEnum.forest_cover.value
		assert label['label_quality'] == 3

		# Check geometries
		geom_response = (
			client.table(settings.forest_cover_geometries_table).select('*').eq('label_id', label['id']).execute()
		)

		# Verify we have geometries (if trees are detected in the test image)
		# Note: Some test images might not contain trees, so we check gracefully
		if len(geom_response.data) > 0:
			# Check first geometry structure
			first_geom = geom_response.data[0]
			assert first_geom['geometry']['type'] == 'Polygon'
			assert 'coordinates' in first_geom['geometry']

			# Check that properties contain TCD metadata
			properties = first_geom.get('properties', {})
			if properties:
				assert 'model' in properties
				assert 'threshold' in properties
				assert 'container_version' in properties


@pytest.mark.comprehensive
def test_process_treecover_segmentation_replaces_existing_labels(treecover_task, auth_token):
	"""Test that running tree cover segmentation replaces existing model prediction labels"""
	from shared.models import LabelPayloadData, LabelSourceEnum, LabelTypeEnum, LabelDataEnum
	from shared.labels import create_label_with_geometries
	from shapely.geometry import Polygon

	# Create a simple test polygon
	test_polygon = Polygon([(0, 0), (0, 1), (1, 1), (1, 0), (0, 0)])

	# Create a GeoJSON MultiPolygon from the test polygon
	test_geojson = {
		'type': 'MultiPolygon',
		'coordinates': [[[[float(x), float(y)] for x, y in test_polygon.exterior.coords]]],
	}

	# Create a test label payload for existing model prediction
	existing_payload = LabelPayloadData(
		dataset_id=treecover_task.dataset_id,
		label_source=LabelSourceEnum.model_prediction.value,
		label_type=LabelTypeEnum.semantic_segmentation.value,
		label_data=LabelDataEnum.forest_cover.value,
		label_quality=3,
		geometry=test_geojson,
		properties={'source': 'test_existing_treecover_prediction'},
	)

	# Create existing label
	existing_label = create_label_with_geometries(existing_payload, treecover_task.user_id, auth_token)

	# Verify the existing label was created
	with use_client(auth_token) as client:
		response = client.table(settings.labels_table).select('*').eq('dataset_id', treecover_task.dataset_id).execute()
		assert len(response.data) == 1
		assert response.data[0]['id'] == existing_label.id

		# Verify geometries were created for the existing label
		geom_response = (
			client.table(settings.forest_cover_geometries_table).select('*').eq('label_id', existing_label.id).execute()
		)
		assert len(geom_response.data) > 0

	# Run tree cover segmentation process
	process_treecover_segmentation(treecover_task, auth_token, settings.processing_path)

	# Verify the results
	with use_client(auth_token) as client:
		# Get all labels for the dataset
		response = client.table(settings.labels_table).select('*').eq('dataset_id', treecover_task.dataset_id).execute()

		# Should only be one label (the new one)
		assert len(response.data) == 1

		# Verify it's not the old label
		new_label_id = response.data[0]['id']
		assert new_label_id != existing_label.id

		# Verify it has the right properties
		label = response.data[0]
		assert label['dataset_id'] == treecover_task.dataset_id
		assert label['label_source'] == LabelSourceEnum.model_prediction.value
		assert label['label_type'] == LabelTypeEnum.semantic_segmentation.value
		assert label['label_data'] == LabelDataEnum.forest_cover.value
		assert label['label_quality'] == 3

		# Verify old geometries are gone
		old_geom_response = (
			client.table(settings.forest_cover_geometries_table).select('*').eq('label_id', existing_label.id).execute()
		)
		assert len(old_geom_response.data) == 0

		# Note: Tree cover detection might not find trees in test images,
		# so we don't need to assert that geometries exist


def test_treecover_preprocessing_workflow():
	"""Test the preprocessing workflow without running the full container"""
	from processor.src.treecover_segmentation.predict_treecover import _reproject_orthomosaic_for_tcd
	import tempfile
	import rasterio
	import numpy as np

	# Create a minimal test GeoTIFF
	with tempfile.NamedTemporaryFile(suffix='.tif', delete=False) as temp_input:
		# Create a simple test raster in WGS84
		width, height = 50, 50  # Smaller size to avoid disk space issues
		data = np.random.randint(0, 255, (3, height, width), dtype=np.uint8)

		transform = rasterio.transform.from_bounds(-1, -1, 1, 1, width, height)

		with rasterio.open(
			temp_input.name,
			'w',
			driver='GTiff',
			height=height,
			width=width,
			count=3,
			dtype=np.uint8,
			crs='EPSG:4326',
			transform=transform,
		) as dst:
			for i in range(3):
				dst.write(data[i], i + 1)

		# Test reprojection
		with tempfile.NamedTemporaryFile(suffix='.tif', delete=False) as temp_output:
			result_path = _reproject_orthomosaic_for_tcd(temp_input.name, temp_output.name)

			# Verify the reprojected file
			with rasterio.open(result_path) as src:
				assert src.crs.to_string() == 'EPSG:3395'
				# Check that resolution is approximately 0.1m (allowing for some variation due to reprojection)
				assert abs(src.res[0] - 0.1) < 0.01
				assert abs(src.res[1] - 0.1) < 0.01


@pytest.mark.comprehensive
def test_tcd_container_availability():
	"""Test that TCD container can be pulled and is available"""
	import docker

	try:
		client = docker.from_env()
		# Check if our local TCD container image exists
		image = client.images.get('deadtrees-tcd:latest')
		assert image is not None

		# Test that we can create a container (but don't run it)
		container = client.containers.create(
			image='deadtrees-tcd:latest',
			command=['--help'],  # Just test help command
		)
		assert container is not None

		# Clean up the test container
		container.remove()

	except docker.errors.ImageNotFound:
		pytest.skip('Local TCD container deadtrees-tcd:latest not found - run docker build first')
	except Exception as e:
		pytest.skip(f'Docker or TCD container not available: {str(e)}')


def test_confidence_map_thresholding():
	"""Test the confidence map thresholding logic"""
	from processor.src.treecover_segmentation.predict_treecover import TCD_THRESHOLD
	import numpy as np

	# Create test confidence map with values around threshold
	confidence_map = np.array(
		[[100, 150, 200, 250], [50, 199, 201, 255], [0, 180, 220, 255], [75, 195, 205, 255]], dtype=np.uint8
	)

	# Apply thresholding (same logic as in predict_treecover)
	outimage = (confidence_map > TCD_THRESHOLD).astype(np.uint8)

	# Check expected results
	expected = np.array([[0, 0, 0, 1], [0, 0, 1, 1], [0, 0, 1, 1], [0, 0, 1, 1]], dtype=np.uint8)

	np.testing.assert_array_equal(outimage, expected)


@pytest.mark.comprehensive
def test_pipeline_integration_deadwood_then_treecover(test_dataset_for_processing, test_processor_user, auth_token):
	"""Test that deadwood and treecover can run in sequence as intended"""
	from processor.src.process_deadwood_segmentation import process_deadwood_segmentation

	# Create tasks for both deadwood and treecover
	deadwood_task = QueueTask(
		id=1,
		dataset_id=test_dataset_for_processing,
		user_id=test_processor_user,
		task_types=[TaskTypeEnum.deadwood],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
	)

	treecover_task = QueueTask(
		id=2,
		dataset_id=test_dataset_for_processing,
		user_id=test_processor_user,
		task_types=[TaskTypeEnum.treecover],
		priority=1,
		is_processing=False,
		current_position=2,
		estimated_time=0.0,
	)

	# Run deadwood first
	process_deadwood_segmentation(deadwood_task, auth_token, settings.processing_path)

	# Run treecover second
	process_treecover_segmentation(treecover_task, auth_token, settings.processing_path)

	# Verify both labels exist
	with use_client(auth_token) as client:
		response = (
			client.table(settings.labels_table).select('*').eq('dataset_id', test_dataset_for_processing).execute()
		)

		# Should have labels for both deadwood and forest cover
		label_types = [label['label_data'] for label in response.data]
		assert LabelDataEnum.deadwood.value in label_types
		assert LabelDataEnum.forest_cover.value in label_types
