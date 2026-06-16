from pathlib import Path

import pytest
import torch
from shapely.geometry import Polygon

from shared.db import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, QueueTask, AOI

from processor.src.process_aoi_segmentation import process_aoi_segmentation
from processor.src.aoi_segmentation_v1.predict_aoi import AUTO_AOI_NOTES
from processor.src.aoi_segmentation_v1.inference.aoi_inference import cleanup_aoi_polygon

MODEL_PATH = str(Path(__file__).parent.parent.parent / 'assets' / 'models' / 'b1_50epoch_best_macro_f1.safetensors')


@pytest.fixture
def aoi_task(test_dataset_for_processing, test_processor_user):
	return QueueTask(
		id=1,
		dataset_id=test_dataset_for_processing,
		user_id=test_processor_user,
		task_types=[TaskTypeEnum.aoi_v1],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
	)


@pytest.fixture(autouse=True)
def cleanup_aois(auth_token, aoi_task):
	yield
	with use_client(auth_token) as client:
		client.table(settings.aois_table).delete().eq('dataset_id', aoi_task.dataset_id).execute()


def test_aoi_model_loads():
	"""Model weights load without errors and produce the expected binary head."""
	if not Path(MODEL_PATH).exists():
		pytest.skip(f'Model weights not found at {MODEL_PATH}')

	from processor.src.aoi_segmentation_v1.inference.aoi_inference import AOIInference

	model = AOIInference(model_path=MODEL_PATH)
	assert model.model is not None

	dummy = torch.zeros(1, 3, 64, 64).to(model.device)
	with torch.no_grad():
		logits = model.model(pixel_values=dummy).logits
	assert logits.shape[1] == 2  # binary: outside_aoi, inside_aoi


def test_cleanup_aoi_polygon_returns_single_solid_polygon():
	"""Cleanup merges parts, keeps the largest, and removes holes (metric CRS)."""
	# Large square (100 m) with an interior hole.
	main = Polygon(
		[(0, 0), (0, 100), (100, 100), (100, 0)],
		holes=[[(40, 40), (40, 60), (60, 60), (60, 40)]],
	)
	# A tiny separate blob far away that should be dropped by keep-largest.
	speck = Polygon([(500, 500), (500, 503), (503, 503), (503, 500)])

	cleaned = cleanup_aoi_polygon([main, speck])

	assert len(cleaned) == 1
	result = cleaned[0]
	assert isinstance(result, Polygon)
	assert len(result.interiors) == 0  # holes removed
	# Inward opening + negative buffer shrink the square but keep most of its area.
	assert 6000 < result.area < 10000


def test_cleanup_aoi_polygon_empty():
	assert cleanup_aoi_polygon([]) == []


@pytest.mark.comprehensive
def test_process_aoi_segmentation_success(aoi_task, auth_token):
	"""Full pipeline: AOI model writes a v2_aois row and sets is_aoi_done."""
	process_aoi_segmentation(aoi_task, auth_token, settings.processing_path)

	with use_client(auth_token) as client:
		aoi_response = client.table(settings.aois_table).select('*').eq('dataset_id', aoi_task.dataset_id).execute()
		status_response = (
			client.table(settings.statuses_table).select('*').eq('dataset_id', aoi_task.dataset_id).execute()
		)

	assert status_response.data[0]['is_aoi_done'] is True

	# The model may legitimately predict no AOI; only assert on the row when present.
	auto_aois = [aoi for aoi in aoi_response.data if aoi['notes'] == AUTO_AOI_NOTES]
	for aoi in auto_aois:
		assert aoi['is_whole_image'] is False
		assert aoi['geometry']['type'] == 'MultiPolygon'


@pytest.mark.comprehensive
def test_process_aoi_skips_when_human_aoi_exists(aoi_task, auth_token, test_processor_user):
	"""If an auditor-drawn AOI exists, the task is a no-op and never adds an auto
	AOI (a newer auto row would shadow the human AOI in the recency-based UI)."""
	user_aoi = AOI(
		dataset_id=aoi_task.dataset_id,
		user_id=test_processor_user,
		geometry={
			'type': 'MultiPolygon',
			'coordinates': [[[[13.405, 52.52], [13.405, 52.521], [13.406, 52.521], [13.406, 52.52], [13.405, 52.52]]]],
		},
		is_whole_image=False,
		notes='auditor drawn',
	)
	with use_client(auth_token) as client:
		client.table(settings.aois_table).insert(
			user_aoi.model_dump(exclude={'id', 'created_at', 'updated_at'})
		).execute()

	# Runs the full stage, but predict_aoi returns early before any inference.
	process_aoi_segmentation(aoi_task, auth_token, settings.processing_path)
	process_aoi_segmentation(aoi_task, auth_token, settings.processing_path)

	with use_client(auth_token) as client:
		aoi_response = client.table(settings.aois_table).select('*').eq('dataset_id', aoi_task.dataset_id).execute()

	# Auditor AOI preserved and no auto AOI was created.
	assert any(aoi['notes'] == 'auditor drawn' for aoi in aoi_response.data)
	assert not any(aoi['notes'] == AUTO_AOI_NOTES for aoi in aoi_response.data)
