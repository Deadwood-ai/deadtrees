import numpy as np
import pytest
import torch
from pathlib import Path

from shared.db import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, QueueTask, LabelDataEnum, LabelSourceEnum, LabelTypeEnum
from processor.src.process_deadwood_treecover_combined_v2 import process_deadwood_treecover_combined_v2

MODEL_PATH = str(
	Path(__file__).parent.parent.parent / 'assets' / 'models' / 'ckpt_weighted_brownweight15_goldentestweight7.safetensors'
)


@pytest.fixture
def combined_task(test_dataset_for_processing, test_processor_user):
	return QueueTask(
		id=1,
		dataset_id=test_dataset_for_processing,
		user_id=test_processor_user,
		task_types=[TaskTypeEnum.deadwood_treecover_combined_v2],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
	)


@pytest.fixture(autouse=True)
def cleanup_labels(auth_token, combined_task):
	yield
	with use_client(auth_token) as client:
		response = (
			client.table(settings.labels_table).select('id').eq('dataset_id', combined_task.dataset_id).execute()
		)
		for label in response.data:
			client.table(settings.deadwood_geometries_table).delete().eq('label_id', label['id']).execute()
			client.table(settings.forest_cover_geometries_table).delete().eq('label_id', label['id']).execute()
		client.table(settings.labels_table).delete().eq('dataset_id', combined_task.dataset_id).execute()


def test_model_loads():
	"""Model weights load without errors and produce the expected architecture."""
	if not Path(MODEL_PATH).exists():
		pytest.skip(f'Model weights not found at {MODEL_PATH}')

	from processor.src.deadwood_treecover_combined_v2.inference.combined_inference import CombinedInference

	model = CombinedInference(model_path=MODEL_PATH)
	assert model.model is not None

	# Verify output shape with a dummy input
	dummy = torch.zeros(1, 3, 64, 64).to(model.device)
	with torch.no_grad():
		logits = model.model(pixel_values=dummy).logits
	assert logits.shape[1] == 3  # 3 classes: background, treecover, deadwood


def test_class_map_extraction():
	"""Argmax correctly separates the three predicted classes."""
	from processor.src.deadwood_treecover_combined_v2.inference.combined_inference import (
		CLASS_BACKGROUND,
		CLASS_DEADWOOD,
		CLASS_TREECOVER,
	)

	# Synthetic logits: highest score at different channels per pixel
	logits = np.array(
		[
			[1.0, 0.0, 0.0],  # pixel → background
			[0.0, 1.0, 0.0],  # pixel → treecover
			[0.0, 0.0, 1.0],  # pixel → deadwood
		]
	)
	class_map = logits.argmax(axis=1).astype(np.int8)

	assert class_map[0] == CLASS_BACKGROUND
	assert class_map[1] == CLASS_TREECOVER
	assert class_map[2] == CLASS_DEADWOOD

	deadwood_mask = (class_map == CLASS_DEADWOOD).astype(np.uint8)
	treecover_mask = (class_map == CLASS_TREECOVER).astype(np.uint8)

	assert deadwood_mask.tolist() == [0, 0, 1]
	assert treecover_mask.tolist() == [0, 1, 0]


@pytest.mark.comprehensive
def test_process_combined_segmentation_success(combined_task, auth_token):
	"""Full pipeline: combined model produces deadwood and forest_cover labels."""
	process_deadwood_treecover_combined_v2(combined_task, auth_token, settings.processing_path)

	with use_client(auth_token) as client:
		response = (
			client.table(settings.labels_table).select('*').eq('dataset_id', combined_task.dataset_id).execute()
		)
		status_response = (
			client.table(settings.statuses_table).select('*').eq('dataset_id', combined_task.dataset_id).execute()
		)

	status = status_response.data[0]
	assert status['is_combined_model_done'] is True
	assert status['is_deadwood_done'] is False
	assert status['is_forest_cover_done'] is False

	label_data_values = {label['label_data'] for label in response.data}
	# The model must save at least one of the two layers (empty predictions are skipped)
	assert label_data_values & {LabelDataEnum.deadwood.value, LabelDataEnum.forest_cover.value}

	for label in response.data:
		assert label['label_source'] == LabelSourceEnum.model_prediction.value
		assert label['label_type'] == LabelTypeEnum.semantic_segmentation.value
		assert label['label_quality'] == 3
		assert label['model_config']['module'] == 'deadwood_treecover_combined_v2'
		assert label['model_config']['checkpoint_name'] == Path(MODEL_PATH).name

		geom_table = (
			settings.deadwood_geometries_table
			if label['label_data'] == LabelDataEnum.deadwood.value
			else settings.forest_cover_geometries_table
		)
		with use_client(auth_token) as client:
			geom_response = client.table(geom_table).select('*').eq('label_id', label['id']).execute()
		if geom_response.data:
			assert geom_response.data[0]['geometry']['type'] == 'Polygon'


@pytest.mark.comprehensive
def test_process_combined_versions_existing_combined_labels_without_deleting_legacy_labels(combined_task, auth_token):
	"""Re-running the combined model preserves labels and only deactivates older combined versions."""
	from shared.models import LabelPayloadData
	from shared.labels import create_label_with_geometries
	from shapely.geometry import Polygon

	test_geojson = {
		'type': 'MultiPolygon',
		'coordinates': [[[[float(x), float(y)] for x, y in Polygon([(0, 0), (0, 1), (1, 1), (1, 0)]).exterior.coords]]],
	}
	model_config = {'module': 'deadwood_treecover_combined_v2', 'checkpoint_name': Path(MODEL_PATH).name}

	existing_combined_ids = {}
	legacy_ids = {}
	for label_data in (LabelDataEnum.deadwood, LabelDataEnum.forest_cover):
		combined_payload = LabelPayloadData(
			dataset_id=combined_task.dataset_id,
			label_source=LabelSourceEnum.model_prediction,
			label_type=LabelTypeEnum.semantic_segmentation,
			label_data=label_data,
			label_quality=3,
			model_metadata=model_config,
			geometry=test_geojson,
		)
		combined_label = create_label_with_geometries(combined_payload, combined_task.user_id, auth_token)
		existing_combined_ids[label_data.value] = combined_label.id

		legacy_payload = LabelPayloadData(
			dataset_id=combined_task.dataset_id,
			label_source=LabelSourceEnum.model_prediction,
			label_type=LabelTypeEnum.semantic_segmentation,
			label_data=label_data,
			label_quality=3,
			model_metadata=None,
			geometry=test_geojson,
		)
		legacy_label = create_label_with_geometries(legacy_payload, combined_task.user_id, auth_token)
		legacy_ids[label_data.value] = legacy_label.id

	process_deadwood_treecover_combined_v2(combined_task, auth_token, settings.processing_path)

	with use_client(auth_token) as client:
		response = (
			client.table(settings.labels_table)
			.select('id,label_data,model_config,is_active,version,parent_label_id')
			.eq('dataset_id', combined_task.dataset_id)
			.execute()
		)

	labels_by_id = {label['id']: label for label in response.data}

	for label_id in legacy_ids.values():
		assert label_id in labels_by_id
		assert labels_by_id[label_id]['is_active'] is True

	for label_data, old_id in existing_combined_ids.items():
		assert old_id in labels_by_id

		new_combined_labels = [
			label
			for label in response.data
			if label['label_data'] == label_data
			and label['id'] != old_id
			and (label.get('model_config') or {}).get('module') == 'deadwood_treecover_combined_v2'
		]
		if not new_combined_labels:
			# Empty predictions leave the previous combined label untouched.
			assert labels_by_id[old_id]['is_active'] is True
			continue

		assert labels_by_id[old_id]['is_active'] is False
		for label in new_combined_labels:
			assert label['is_active'] is True
			assert label['version'] == 2
			assert label['parent_label_id'] == old_id
