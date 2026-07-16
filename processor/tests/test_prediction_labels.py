from types import SimpleNamespace

import pytest

from shared.models import Label, LabelDataEnum, LabelSourceEnum, LabelTypeEnum
from processor.src.utils import prediction_labels

pytestmark = pytest.mark.unit


class FakeLabelsQuery:
	def __init__(self, client, table_name):
		self.client = client
		self.table_name = table_name
		self.update_payload = None
		self.eq_filters = []
		self.in_filter = None

	def select(self, *_args):
		return self

	def eq(self, column, value):
		self.eq_filters.append((column, value))
		return self

	def update(self, payload):
		self.update_payload = payload
		return self

	def in_(self, column, values):
		self.in_filter = (column, values)
		return self

	def execute(self):
		if self.update_payload is not None:
			self.client.updates.append(
				{
					'table': self.table_name,
					'payload': self.update_payload,
					'eq_filters': self.eq_filters,
					'in_filter': self.in_filter,
				}
			)
			return SimpleNamespace(data=[])

		return SimpleNamespace(data=self.client.existing_labels)


class FakeLabelsClient:
	def __init__(self, existing_labels):
		self.existing_labels = existing_labels
		self.updates = []

	def table(self, table_name):
		return FakeLabelsQuery(self, table_name)

	def __enter__(self):
		return self

	def __exit__(self, *_args):
		return False


def test_create_versioned_model_prediction_label_deactivates_only_matching_model_config(monkeypatch):
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
	assert fake_client.updates[0]['payload'] == {
		'is_active': True,
		'version': 3,
		'parent_label_id': 10,
	}
	assert fake_client.updates[0]['eq_filters'] == [('id', 99)]
	assert fake_client.updates[1]['payload'] == {'is_active': False}
	assert fake_client.updates[1]['in_filter'] == ('id', [10, 13])
