from types import SimpleNamespace

import pytest

from shared.models import Label, LabelDataEnum, LabelSourceEnum, LabelTypeEnum
from processor.src.utils import prediction_labels

pytestmark = pytest.mark.unit


class FakeLabelsClient:
	def __init__(self, existing_labels):
		self.existing_labels = existing_labels
		self.updates = []
		self.publications = []

	def rpc(self, name, params):
		self.publications.append((name, params))
		return SimpleNamespace(
			execute=lambda: SimpleNamespace(
				data={
					'id': 99,
					'dataset_id': 123,
					'user_id': 'processor-user',
					'label_source': 'model_prediction',
					'label_type': 'semantic_segmentation',
					'label_data': 'forest_cover',
					'model_config': self.existing_labels[0]['model_config'],
					'is_active': True,
					'version': 3,
					'parent_label_id': 10,
				}
			)
		)

	def table(self, table_name):
		raise AssertionError('Versioning must use the atomic publication RPC')

	def __enter__(self):
		return self

	def __exit__(self, *_args):
		return False


def test_create_versioned_model_prediction_label_delegates_atomic_publication(monkeypatch):
	model_config = {
		'module': 'deadwood_treecover_combined_v2',
		'checkpoint_name': 'combined.safetensors',
	}
	legacy_config = {
		'module': 'treecover_segmentation_oam_tcd',
		'checkpoint_name': 'legacy.safetensors',
	}
	fake_client = FakeLabelsClient(
		[
			{'id': 10, 'model_config': model_config, 'is_active': True, 'version': 1},
			{'id': 11, 'model_config': None, 'is_active': True, 'version': 1},
			{'id': 12, 'model_config': legacy_config, 'is_active': True, 'version': 1},
			{'id': 13, 'model_config': model_config, 'is_active': False, 'version': 2},
		]
	)

	monkeypatch.setattr(prediction_labels, 'login', lambda *_args: 'processor-token')
	monkeypatch.setattr(prediction_labels, 'use_client', lambda *_args, **_kwargs: fake_client)
	monkeypatch.setattr(prediction_labels.logger, 'info', lambda *_args, **_kwargs: None)
	monkeypatch.setattr(
		prediction_labels,
		'create_label_with_geometries',
		lambda *_args, **_kwargs: Label(
			id=99,
			dataset_id=123,
			user_id='processor-user',
			label_source=LabelSourceEnum.model_prediction,
			label_type=LabelTypeEnum.semantic_segmentation,
			label_data=LabelDataEnum.forest_cover,
			label_quality=3,
			model_metadata=model_config,
		),
	)

	label = prediction_labels.create_versioned_model_prediction_label(
		dataset_id=123,
		user_id='processor-user',
		label_data=LabelDataEnum.forest_cover,
		geometry={'type': 'MultiPolygon', 'coordinates': []},
		token='old-token',
		model_config=model_config,
	)

	assert label.id == 99
	assert label.is_active and label.version == 3 and label.parent_label_id == 10
	assert fake_client.publications == [
		('publish_model_prediction_label', {'p_label_id': 99, 'p_expected_geometry_count': 0})
	]
	assert fake_client.updates == []
