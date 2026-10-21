"""The label GeoPackage export only includes an AOI of the label's own dataset."""

from contextlib import contextmanager
from types import SimpleNamespace

import json

import fiona
import geopandas as gpd

from api.src.download import downloads
from api.src.download.jobs import ExportKind, JobState, Manifest, PreparedFileJob
from shared.models import Label, LabelDataEnum, LabelSourceEnum, LabelTypeEnum
from shared.settings import settings

SQUARE = {'type': 'Polygon', 'coordinates': [[[8, 48], [8.1, 48], [8.1, 48.1], [8, 48.1], [8, 48]]]}


class FakeQuery:
	"""Applies `eq` filters and `range` to in-memory rows; other calls pass through."""

	def __init__(self, rows):
		self.rows = rows
		self.filters = []
		self.offset = 0
		self.limit = None

	def select(self, *_):
		return self

	def eq(self, column, value):
		self.filters.append((column, value))
		return self

	@property
	def not_(self):
		return self

	def is_(self, *_):
		return self

	def order(self, *_):
		return self

	def range(self, start, end):
		self.offset, self.limit = start, end - start + 1
		return self

	def execute(self):
		rows = [row for row in self.rows if all(row.get(col) == val for col, val in self.filters)]
		rows = rows[self.offset :]
		if self.limit is not None:
			rows = rows[: self.limit]
		return SimpleNamespace(data=rows)


class FakeClient:
	def __init__(self, tables):
		self.tables = tables

	def table(self, name):
		return FakeQuery(self.tables.get(name, []))


def _export(tmp_path, monkeypatch, label_aoi_id):
	tables = {
		settings.deadwood_geometries_table: [
			{'id': 1, 'label_id': 10, 'geometry': SQUARE, 'properties': {}},
		],
		settings.aois_table: [
			{'id': 100, 'dataset_id': 1, 'geometry': SQUARE, 'notes': 'own aoi', 'image_quality': 1},
			{'id': 200, 'dataset_id': 2, 'geometry': SQUARE, 'notes': 'other dataset', 'image_quality': 2},
		],
	}

	@contextmanager
	def fake_service_client():
		yield FakeClient(tables)

	monkeypatch.setattr(downloads, 'use_service_client', fake_service_client)

	label = Label(
		id=10,
		dataset_id=1,
		aoi_id=label_aoi_id,
		user_id='user',
		label_source=LabelSourceEnum.visual_interpretation,
		label_type=LabelTypeEnum.semantic_segmentation,
		label_data=LabelDataEnum.deadwood,
	)
	label_file = tmp_path / 'labels.gpkg'
	downloads.label_to_geopackage(str(label_file), label)
	return label_file


def test_export_includes_the_labels_own_aoi(tmp_path, monkeypatch):
	label_file = _export(tmp_path, monkeypatch, label_aoi_id=100)

	aoi = gpd.read_file(label_file, layer='aoi_deadwood')
	assert list(aoi['notes']) == ['own aoi']


def test_export_skips_an_aoi_of_another_dataset(tmp_path, monkeypatch):
	label_file = _export(tmp_path, monkeypatch, label_aoi_id=200)

	assert 'aoi_deadwood' not in fiona.listlayers(label_file)
	assert len(gpd.read_file(label_file, layer='deadwood_visual_interpretation')) == 1


def test_files_prepared_before_the_fix_are_no_longer_served(tmp_path):
	job = PreparedFileJob(tmp_path / 'labels.gpkg')
	assert job.claim()
	job.run(lambda target: target.write_bytes(b'gpkg'), Manifest(ExportKind.LABELS, (1,)))
	assert job.status().state == JobState.COMPLETED

	payload = json.loads(job.manifest_path.read_text())
	payload['version'] = 1
	job.manifest_path.write_text(json.dumps(payload))

	assert job.status().state != JobState.COMPLETED
