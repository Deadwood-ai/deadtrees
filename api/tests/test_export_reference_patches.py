import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import fiona
import geopandas as gpd

from api.src.export import export_reference_patches as export_module


class FakeQuery:
	def __init__(self, rows):
		self.rows = [dict(row) for row in rows]
		self.filters = []
		self.order_columns = []

	def select(self, *_args, **_kwargs):
		return self

	def eq(self, column, value):
		self.filters.append(('eq', column, value))
		return self

	def in_(self, column, values):
		self.filters.append(('in', column, tuple(values)))
		return self

	def order(self, column):
		self.order_columns.append(column)
		return self

	def execute(self):
		rows = [dict(row) for row in self.rows]

		for filter_type, column, value in self.filters:
			if filter_type == 'eq':
				rows = [row for row in rows if row.get(column) == value]
			elif filter_type == 'in':
				rows = [row for row in rows if row.get(column) in value]

		for column in reversed(self.order_columns):
			rows = sorted(rows, key=lambda row: row.get(column))

		return SimpleNamespace(data=rows)


class FakeClient:
	def __init__(self, tables):
		self.tables = tables

	def from_(self, table_name):
		return FakeQuery(self.tables.get(table_name, []))


class FakeUseClient:
	def __init__(self, tables):
		self.client = FakeClient(tables)

	def __enter__(self):
		return self.client

	def __exit__(self, exc_type, exc, tb):
		return False


def make_patch(
	patch_id,
	patch_index,
	*,
	dataset_id=10,
	resolution_cm=20,
	parent_tile_id=None,
	deadwood_validated=None,
	forest_cover_validated=None,
	reference_deadwood_label_id=None,
	reference_forest_cover_label_id=None,
	updated_at='2026-04-07T13:57:22+00:00',
	geometry=None,
):
	return {
		'id': patch_id,
		'dataset_id': dataset_id,
		'patch_index': patch_index,
		'resolution_cm': resolution_cm,
		'parent_tile_id': parent_tile_id,
		'deadwood_validated': deadwood_validated,
		'forest_cover_validated': forest_cover_validated,
		'reference_deadwood_label_id': reference_deadwood_label_id,
		'reference_forest_cover_label_id': reference_forest_cover_label_id,
		'updated_at': updated_at,
		'geometry': geometry
		or {
			'type': 'Polygon',
			'coordinates': [[[7.0, 47.0], [7.1, 47.0], [7.1, 47.1], [7.0, 47.1], [7.0, 47.0]]],
		},
	}


def install_fake_db(monkeypatch, tables):
	monkeypatch.setattr(export_module, 'use_client', lambda _token: FakeUseClient(tables))
	monkeypatch.setattr(export_module, 'fetch_reference_datasets', lambda _token: [10])


def test_fetch_validated_patches_includes_single_label_validations_by_default(monkeypatch):
	tables = {
		'reference_patches': [
			make_patch(1, '20_both', deadwood_validated=True, forest_cover_validated=True),
			make_patch(2, '20_deadwood_only', deadwood_validated=True, forest_cover_validated=False),
			make_patch(3, '20_forest_only', deadwood_validated=False, forest_cover_validated=True),
			make_patch(4, '20_unvalidated', deadwood_validated=False, forest_cover_validated=False),
		]
	}
	install_fake_db(monkeypatch, tables)

	patches = export_module.fetch_validated_patches('token')

	assert [patch['id'] for patch in patches] == [1, 2, 3]


def test_fetch_validated_patches_specific_layer_filters_still_work(monkeypatch):
	tables = {
		'reference_patches': [
			make_patch(1, '20_both', deadwood_validated=True, forest_cover_validated=True),
			make_patch(2, '20_deadwood_only', deadwood_validated=True, forest_cover_validated=False),
			make_patch(3, '20_forest_only', deadwood_validated=False, forest_cover_validated=True),
		]
	}
	install_fake_db(monkeypatch, tables)

	deadwood_patches = export_module.fetch_validated_patches('token', deadwood_only=True)
	forest_patches = export_module.fetch_validated_patches('token', forest_cover_only=True)

	assert [patch['id'] for patch in deadwood_patches] == [1, 2]
	assert [patch['id'] for patch in forest_patches] == [1, 3]


def test_fetch_validated_patches_resolves_effective_labels_for_single_validation_patch(monkeypatch):
	tables = {
		'reference_patches': [
			make_patch(
				100,
				'20_parent',
				deadwood_validated=True,
				forest_cover_validated=False,
				reference_deadwood_label_id=9001,
				reference_forest_cover_label_id=9002,
			),
			make_patch(
				101,
				'20_parent_0',
				resolution_cm=10,
				parent_tile_id=100,
				deadwood_validated=False,
				forest_cover_validated=True,
				reference_forest_cover_label_id=9102,
			),
		]
	}
	install_fake_db(monkeypatch, tables)

	patches = export_module.fetch_validated_patches('token')
	child_patch = next(patch for patch in patches if patch['id'] == 101)

	assert child_patch['effective_deadwood_label_id'] == 9001
	assert child_patch['effective_forestcover_label_id'] == 9102


def test_get_vector_export_candidates_only_includes_root_20cm_patches():
	patches = [
		make_patch(1, '20_root_valid', resolution_cm=20, deadwood_validated=True),
		make_patch(2, '20_child_valid', resolution_cm=20, parent_tile_id=1, deadwood_validated=True),
		make_patch(3, '10_child_valid', resolution_cm=10, parent_tile_id=1, forest_cover_validated=True),
		make_patch(4, '20_root_unvalidated', resolution_cm=20, deadwood_validated=False, forest_cover_validated=False),
	]

	candidates = export_module.get_vector_export_candidates(patches)

	assert [patch['id'] for patch in candidates] == [1]


def test_get_vector_export_candidates_skips_when_resolution_filter_is_not_20():
	patches = [make_patch(1, '20_root_valid', resolution_cm=20, deadwood_validated=True)]

	assert export_module.get_vector_export_candidates(patches, resolution_cm=5) == []
	assert export_module.get_vector_export_candidates(patches, resolution_cm=10) == []


def test_vector_export_needs_export_checks_gpkg_and_metadata(tmp_path):
	output_dir = tmp_path / '10'
	(output_dir / 'gpkg').mkdir(parents=True)
	(output_dir / 'metadata').mkdir(parents=True)

	filename_base = '10_0_0_20cm'
	patch_updated_at = datetime(2026, 4, 9, 12, 0, tzinfo=timezone.utc)

	assert export_module.vector_export_needs_export(output_dir, filename_base, patch_updated_at) is True

	gpkg_path = output_dir / 'gpkg' / f'{filename_base}.gpkg'
	metadata_path = output_dir / 'metadata' / f'{filename_base}_vector.json'
	gpkg_path.write_text('gpkg')
	metadata_path.write_text('{}')

	old_mtime = (patch_updated_at - timedelta(hours=1)).timestamp()
	metadata_path.touch()
	gpkg_path.touch()
	import os

	os.utime(metadata_path, (old_mtime, old_mtime))
	assert export_module.vector_export_needs_export(output_dir, filename_base, patch_updated_at) is True

	new_mtime = (patch_updated_at + timedelta(hours=1)).timestamp()
	os.utime(metadata_path, (new_mtime, new_mtime))
	assert export_module.vector_export_needs_export(output_dir, filename_base, patch_updated_at) is False


def test_export_vector_geopackage_writes_validated_layers_only(monkeypatch, tmp_path):
	patch = make_patch(
		1,
		'20_1760951000108',
		deadwood_validated=True,
		forest_cover_validated=False,
		reference_deadwood_label_id=9001,
		reference_forest_cover_label_id=9002,
	)
	tables = {
		'reference_patch_deadwood_geometries': [
			{
				'patch_id': 1,
				'label_id': 9001,
				'geometry': {
					'type': 'Polygon',
					'coordinates': [[[7.01, 47.01], [7.02, 47.01], [7.02, 47.02], [7.01, 47.02], [7.01, 47.01]]],
				},
				'area_m2': 12.5,
				'properties': {'source': 'test'},
			}
		],
		'reference_patch_forest_cover_geometries': [
			{
				'patch_id': 1,
				'label_id': 9002,
				'geometry': {
					'type': 'Polygon',
					'coordinates': [[[7.03, 47.03], [7.04, 47.03], [7.04, 47.04], [7.03, 47.04], [7.03, 47.03]]],
				},
				'area_m2': 8.0,
				'properties': {'source': 'test'},
			}
		],
	}
	install_fake_db(monkeypatch, tables)

	gpkg_path = export_module.export_vector_geopackage('token', patch, tmp_path / '10')

	assert gpkg_path is not None
	assert gpkg_path.exists()

	layers = fiona.listlayers(gpkg_path)
	assert layers == ['base_patch', 'deadwood']

	base_patch_gdf = gpd.read_file(gpkg_path, layer='base_patch')
	deadwood_gdf = gpd.read_file(gpkg_path, layer='deadwood')

	assert len(base_patch_gdf) == 1
	assert len(deadwood_gdf) == 1
	assert deadwood_gdf.iloc[0]['label_id'] == 9001
	assert deadwood_gdf.iloc[0]['layer_name'] == 'deadwood'
	assert json.loads(deadwood_gdf.iloc[0]['properties_json']) == {'source': 'test'}

	filename_base = export_module.build_filename_base(patch)
	metadata_path = tmp_path / '10' / 'metadata' / f'{filename_base}_vector.json'
	metadata = json.loads(metadata_path.read_text())
	assert metadata['layers'] == {'deadwood': True, 'forest_cover': False}
	assert metadata['feature_counts']['deadwood'] == 1
	assert metadata['feature_counts']['forest_cover'] == 0


def test_export_vector_geopackage_writes_both_layers_when_both_validated(monkeypatch, tmp_path):
	patch = make_patch(
		1,
		'20_1760951000108',
		deadwood_validated=True,
		forest_cover_validated=True,
		reference_deadwood_label_id=9001,
		reference_forest_cover_label_id=9002,
	)
	tables = {
		'reference_patch_deadwood_geometries': [
			{
				'patch_id': 1,
				'label_id': 9001,
				'geometry': {
					'type': 'Polygon',
					'coordinates': [[[7.01, 47.01], [7.02, 47.01], [7.02, 47.02], [7.01, 47.02], [7.01, 47.01]]],
				},
				'area_m2': 12.5,
				'properties': {},
			}
		],
		'reference_patch_forest_cover_geometries': [
			{
				'patch_id': 1,
				'label_id': 9002,
				'geometry': {
					'type': 'Polygon',
					'coordinates': [[[7.03, 47.03], [7.04, 47.03], [7.04, 47.04], [7.03, 47.04], [7.03, 47.03]]],
				},
				'area_m2': 8.0,
				'properties': {},
			}
		],
	}
	install_fake_db(monkeypatch, tables)

	gpkg_path = export_module.export_vector_geopackage('token', patch, tmp_path / '10')

	assert gpkg_path is not None
	assert fiona.listlayers(gpkg_path) == ['base_patch', 'deadwood', 'forest_cover']


def test_export_vector_geopackage_creates_empty_validated_layer(monkeypatch, tmp_path):
	patch = make_patch(
		1,
		'20_1760951000108',
		deadwood_validated=False,
		forest_cover_validated=True,
		reference_forest_cover_label_id=9002,
	)
	tables = {
		'reference_patch_deadwood_geometries': [],
		'reference_patch_forest_cover_geometries': [],
	}
	install_fake_db(monkeypatch, tables)

	gpkg_path = export_module.export_vector_geopackage('token', patch, tmp_path / '10')

	assert gpkg_path is not None
	assert fiona.listlayers(gpkg_path) == ['base_patch', 'forest_cover']

	forest_cover_gdf = gpd.read_file(gpkg_path, layer='forest_cover')
	assert len(forest_cover_gdf) == 0
