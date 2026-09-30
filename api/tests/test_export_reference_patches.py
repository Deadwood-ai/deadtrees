import json
import sys
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import fiona
import geopandas as gpd
import pytest

from api.src.export import export_reference_patches as export_module
from api.src.export import reference_fetch as fetch_module

pytestmark = pytest.mark.unit


class FakeQuery:
	def __init__(self, rows):
		self.rows = [dict(row) for row in rows]
		self.filters = []
		self.order_columns = []
		self.limit_count = None
		self.range_bounds = None

	def select(self, *_args, **_kwargs):
		return self

	def eq(self, column, value):
		self.filters.append(('eq', column, value))
		return self

	def in_(self, column, values):
		self.filters.append(('in', column, tuple(values)))
		return self

	def order(self, column, desc=False):
		self.order_columns.append((column, desc))
		return self

	def limit(self, count):
		self.limit_count = count
		return self

	def range(self, start, end):
		self.range_bounds = (start, end)
		return self

	def execute(self):
		rows = [dict(row) for row in self.rows]

		for filter_type, column, value in self.filters:
			if filter_type == 'eq':
				rows = [row for row in rows if row.get(column) == value]
			elif filter_type == 'in':
				rows = [row for row in rows if row.get(column) in value]

		for column, desc in reversed(self.order_columns):
			if all(row.get(column) is not None for row in rows):
				rows = sorted(rows, key=lambda row: row.get(column), reverse=desc)

		# PostgREST applies max_rows (1000) to every response, ranged or not.
		start, end = self.range_bounds or (0, len(rows) - 1)
		rows = rows[start : min(end + 1, start + 1000)]
		return SimpleNamespace(data=rows[:self.limit_count] if self.limit_count is not None else rows)


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
	monkeypatch.setattr(fetch_module, 'use_client', lambda _token: FakeUseClient(tables))
	monkeypatch.setattr(fetch_module, 'fetch_reference_datasets', lambda _token: [10])


def test_fetch_aoi_geometry_uses_latest_manual_correction(monkeypatch):
	prediction_geometry = {'type': 'Polygon', 'coordinates': [[[0, 0], [1, 0], [0, 0]]]}
	correction_geometry = {'type': 'Polygon', 'coordinates': [[[2, 2], [3, 2], [2, 2]]]}
	tables = {
		'v2_aois': [
			{
				'dataset_id': 10,
				'geometry': prediction_geometry,
				'created_at': '2026-07-16T10:00:00+00:00',
			},
			{
				'dataset_id': 10,
				'geometry': correction_geometry,
				'created_at': '2026-07-16T11:00:00+00:00',
			},
		]
	}
	install_fake_db(monkeypatch, tables)

	assert export_module.fetch_aoi_geometry('token', 10) == correction_geometry


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


def test_cleanup_removed_patch_exports_removes_stale_replaced_patch_files(tmp_path):
	dataset_dir = tmp_path / '3251'
	for subdir in ('geotiff', 'png', 'metadata', 'gpkg'):
		(dataset_dir / subdir).mkdir(parents=True)

	current_root = make_patch(
		1,
		'20_1776848107785',
		dataset_id=3251,
		deadwood_validated=True,
		forest_cover_validated=True,
	)
	current_child = make_patch(
		2,
		'1776848107785_0',
		dataset_id=3251,
		resolution_cm=10,
		parent_tile_id=1,
		deadwood_validated=True,
		forest_cover_validated=True,
	)
	current_leaf = make_patch(
		3,
		'0_0',
		dataset_id=3251,
		resolution_cm=5,
		parent_tile_id=2,
		deadwood_validated=True,
		forest_cover_validated=True,
	)
	patches = [current_root, current_child, current_leaf]

	current_bases = [export_module.build_filename_base(patch) for patch in patches]
	stale_bases = [
		'3251_20_1761645491783_20cm',
		'3251_1761645491783_0_10cm',
	]

	for filename_base in current_bases + stale_bases:
		(dataset_dir / 'geotiff' / f'{filename_base}.tif').write_text('rgb')
		(dataset_dir / 'geotiff' / f'{filename_base}_deadwood_ref.tif').write_text('deadwood')
		(dataset_dir / 'geotiff' / f'{filename_base}_forestcover_ref.tif').write_text('forest')
		(dataset_dir / 'png' / f'{filename_base}.png').write_text('rgb')
		(dataset_dir / 'png' / f'{filename_base}_deadwood_ref.png').write_text('deadwood')
		(dataset_dir / 'png' / f'{filename_base}_forestcover_ref.png').write_text('forest')
		(dataset_dir / 'metadata' / f'{filename_base}.json').write_text('{}')

	for filename_base in [current_bases[0], stale_bases[0]]:
		(dataset_dir / 'gpkg' / f'{filename_base}.gpkg').write_text('gpkg')
		(dataset_dir / 'metadata' / f'{filename_base}_vector.json').write_text('{}')

	(dataset_dir / 'metadata' / 'README.txt').write_text('leave me alone')

	removed_count = export_module.cleanup_removed_patch_exports(
		tmp_path,
		patches,
		reference_dataset_ids=[3251],
	)

	assert removed_count == 16
	for filename_base in current_bases:
		assert (dataset_dir / 'geotiff' / f'{filename_base}.tif').exists()
		assert (dataset_dir / 'png' / f'{filename_base}.png').exists()
		assert (dataset_dir / 'metadata' / f'{filename_base}.json').exists()
	assert (dataset_dir / 'gpkg' / f'{current_bases[0]}.gpkg').exists()
	assert (dataset_dir / 'metadata' / f'{current_bases[0]}_vector.json').exists()
	assert (dataset_dir / 'metadata' / 'README.txt').exists()

	for filename_base in stale_bases:
		assert not (dataset_dir / 'geotiff' / f'{filename_base}.tif').exists()
		assert not (dataset_dir / 'png' / f'{filename_base}.png').exists()
		assert not (dataset_dir / 'metadata' / f'{filename_base}.json').exists()
	assert not (dataset_dir / 'gpkg' / f'{stale_bases[0]}.gpkg').exists()
	assert not (dataset_dir / 'metadata' / f'{stale_bases[0]}_vector.json').exists()


def test_cleanup_removed_patch_exports_respects_resolution_filter(tmp_path):
	dataset_dir = tmp_path / '3251'
	for subdir in ('geotiff', 'png', 'metadata'):
		(dataset_dir / subdir).mkdir(parents=True)

	current_5cm = make_patch(
		1,
		'0_0',
		dataset_id=3251,
		resolution_cm=5,
		deadwood_validated=True,
	)
	stale_5cm_base = '3251_0_1_5cm'
	stale_10cm_base = '3251_1761645491783_0_10cm'

	for filename_base in [export_module.build_filename_base(current_5cm), stale_5cm_base, stale_10cm_base]:
		(dataset_dir / 'geotiff' / f'{filename_base}.tif').write_text('rgb')
		(dataset_dir / 'png' / f'{filename_base}.png').write_text('rgb')
		(dataset_dir / 'metadata' / f'{filename_base}.json').write_text('{}')

	removed_count = export_module.cleanup_removed_patch_exports(
		tmp_path,
		[current_5cm],
		reference_dataset_ids=[3251],
		resolution_cm=5,
	)

	assert removed_count == 3
	assert not (dataset_dir / 'geotiff' / f'{stale_5cm_base}.tif').exists()
	assert (dataset_dir / 'geotiff' / f'{stale_10cm_base}.tif').exists()


def test_main_runs_scoped_stale_cleanup_when_no_validated_patches(monkeypatch, tmp_path):
	cleanup_calls = []

	monkeypatch.setattr(sys, 'argv', ['export_reference_patches.py', '--output-dir', str(tmp_path), '--dataset-id', '3251'])
	monkeypatch.setattr(export_module, 'login', lambda _user, _password: 'token')
	monkeypatch.setattr(export_module, 'fetch_reference_datasets', lambda _token: [3251])
	monkeypatch.setattr(export_module, 'fetch_validated_patches', lambda *_args, **_kwargs: [])
	monkeypatch.setattr(export_module, 'cleanup_removed_datasets', lambda *_args, **_kwargs: None)
	monkeypatch.setattr(
		export_module,
		'cleanup_removed_patch_exports',
		lambda *args, **kwargs: cleanup_calls.append((args, kwargs)) or 0,
	)

	assert export_module.main() == 0
	assert len(cleanup_calls) == 1
	assert cleanup_calls[0][0][1] == []
	assert cleanup_calls[0][1] == {'dataset_id': 3251, 'resolution_cm': None}


def test_main_skips_stale_cleanup_when_patch_fetch_fails(monkeypatch, tmp_path):
	cleanup_calls = []

	monkeypatch.setattr(sys, 'argv', ['export_reference_patches.py', '--output-dir', str(tmp_path), '--dataset-id', '3251'])
	monkeypatch.setattr(export_module, 'login', lambda _user, _password: 'token')
	monkeypatch.setattr(export_module, 'fetch_reference_datasets', lambda _token: [3251])
	def fail_patch_fetch(*_args, **_kwargs):
		raise RuntimeError('database unavailable')

	monkeypatch.setattr(export_module, 'fetch_validated_patches', fail_patch_fetch)
	monkeypatch.setattr(export_module, 'cleanup_removed_datasets', lambda *_args, **_kwargs: None)
	monkeypatch.setattr(
		export_module,
		'cleanup_removed_patch_exports',
		lambda *args, **kwargs: cleanup_calls.append((args, kwargs)) or 0,
	)

	assert export_module.main() == 1
	assert cleanup_calls == []


def test_fetch_latest_reference_geometry_created_at_uses_latest_geometry_table_timestamp(monkeypatch):
	tables = {
		'reference_patch_deadwood_geometries': [
			{'patch_id': 1, 'created_at': '2026-04-09T10:00:00+00:00'},
			{'patch_id': 1, 'created_at': '2026-04-09T11:00:00+00:00'},
		],
		'reference_patch_forest_cover_geometries': [
			{'patch_id': 1, 'created_at': '2026-04-09T12:00:00+00:00'},
			{'patch_id': 2, 'created_at': '2026-04-09T13:00:00+00:00'},
		],
	}
	install_fake_db(monkeypatch, tables)

	latest_created_at = export_module.fetch_latest_reference_geometry_created_at('token', 1)

	assert latest_created_at == datetime(2026, 4, 9, 12, 0, tzinfo=timezone.utc)


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


def test_export_vector_geopackage_fails_on_invalid_validated_geometry(monkeypatch, tmp_path):
	patch = make_patch(
		1,
		'20_1760951000108',
		deadwood_validated=True,
		forest_cover_validated=False,
		reference_deadwood_label_id=9001,
	)
	tables = {
		'reference_patch_deadwood_geometries': [
			{
				'patch_id': 1,
				'label_id': 9001,
				'geometry': {
					'type': 'Point',
					'coordinates': [7.01, 47.01],
				},
				'area_m2': 12.5,
				'properties': {'source': 'test'},
			}
		],
		'reference_patch_forest_cover_geometries': [],
	}
	install_fake_db(monkeypatch, tables)

	gpkg_path = export_module.export_vector_geopackage('token', patch, tmp_path / '10')
	filename_base = export_module.build_filename_base(patch)

	assert gpkg_path is None
	assert not (tmp_path / '10' / 'gpkg' / f'{filename_base}.gpkg').exists()


UTM_EPSG = 32632
UTM_BBOX = (500000.0, 5200000.0, 500204.8, 5200204.8)


def utm_square_as_wgs84(minx, miny, maxx, maxy):
	from pyproj import Transformer

	to_wgs84 = Transformer.from_crs(f'EPSG:{UTM_EPSG}', 'EPSG:4326', always_xy=True)
	ring = [to_wgs84.transform(x, y) for x, y in [(minx, miny), (maxx, miny), (maxx, maxy), (minx, maxy), (minx, miny)]]
	return {'type': 'Polygon', 'coordinates': [[list(point) for point in ring]]}


class FailingClient:
	def __init__(self, tables, failing_tables):
		self.client = FakeClient(tables)
		self.failing_tables = failing_tables

	def from_(self, table_name):
		if table_name in self.failing_tables:
			raise RuntimeError(f'database unavailable for {table_name}')
		return self.client.from_(table_name)


def test_fetch_geometries_by_label_reads_every_page_beyond_postgrest_cap(monkeypatch):
	minx, miny, _, _ = UTM_BBOX
	rows = [
		{
			'id': index,
			'label_id': 7,
			'geometry': utm_square_as_wgs84(minx + index % 100, miny + index // 100, minx + index % 100 + 0.5, miny + index // 100 + 0.5),
		}
		for index in range(2500)
	]
	install_fake_db(monkeypatch, {'reference_patch_deadwood_geometries': rows})

	geometries = export_module.fetch_geometries_by_label(
		'token', 7, 'reference_patch_deadwood_geometries', UTM_BBOX, UTM_EPSG
	)

	assert len(geometries) == 2500


def test_fetch_geometries_by_label_rejects_unparseable_geometry(monkeypatch):
	rows = [
		{'id': 1, 'label_id': 7, 'geometry': utm_square_as_wgs84(*UTM_BBOX)},
		{'id': 2, 'label_id': 7, 'geometry': {'type': 'Polygon', 'coordinates': [[[7.0, 47.0]]]}},
	]
	install_fake_db(monkeypatch, {'reference_patch_deadwood_geometries': rows})

	with pytest.raises(ValueError, match='Invalid geometry 2'):
		export_module.fetch_geometries_by_label('token', 7, 'reference_patch_deadwood_geometries', UTM_BBOX, UTM_EPSG)


def test_fetch_errors_propagate_instead_of_returning_empty_results(monkeypatch):
	failing_tables = {'reference_patch_deadwood_geometries', 'v2_aois'}
	monkeypatch.setattr(fetch_module, 'use_client', lambda _token: _failing_use_client({}, failing_tables))

	with pytest.raises(RuntimeError, match='database unavailable'):
		export_module.fetch_geometries_by_label('token', 7, 'reference_patch_deadwood_geometries', UTM_BBOX, UTM_EPSG)
	with pytest.raises(RuntimeError, match='database unavailable'):
		export_module.fetch_vector_features_by_label('token', 1, 7, 'reference_patch_deadwood_geometries')
	with pytest.raises(RuntimeError, match='database unavailable'):
		export_module.fetch_aoi_geometry('token', 10)


def _failing_use_client(tables, failing_tables):
	use = FakeUseClient(tables)
	use.client = FailingClient(tables, failing_tables)
	return use


def test_create_aoi_mask_only_treats_missing_aoi_as_all_valid():
	assert export_module.create_aoi_mask(None, UTM_BBOX, UTM_EPSG).all()

	minx, miny, maxx, maxy = UTM_BBOX
	half = export_module.create_aoi_mask(utm_square_as_wgs84(minx, miny, (minx + maxx) / 2, maxy), UTM_BBOX, UTM_EPSG)
	assert 0.45 < half.mean() < 0.55


@pytest.mark.parametrize(
	'aoi',
	[
		{},
		{'type': 'Polygon', 'coordinates': [[[7.0, 47.0]]]},
		{'type': 'Polygon', 'coordinates': [[[7.0, 470.0], [7.1, 470.0], [7.1, 470.1], [7.0, 470.0]]]},
	],
	ids=['empty-object', 'unparseable', 'not-reprojectable'],
)
def test_create_aoi_mask_rejects_invalid_aoi(aoi):
	with pytest.raises(ValueError, match='AOI'):
		export_module.create_aoi_mask(aoi, UTM_BBOX, UTM_EPSG)


def write_utm_cog(path):
	import numpy as np
	import rasterio
	from rasterio.transform import from_bounds

	with rasterio.open(
		path,
		'w',
		driver='GTiff',
		width=256,
		height=256,
		count=3,
		dtype='uint8',
		crs=f'EPSG:{UTM_EPSG}',
		transform=from_bounds(*UTM_BBOX, 256, 256),
	) as dst:
		dst.write(np.full((3, 256, 256), 120, dtype='uint8'))


def run_main_with_one_validated_patch(monkeypatch, tmp_path, use_client):
	cog_dir = tmp_path / 'cogs'
	cog_dir.mkdir()
	write_utm_cog(cog_dir / 'ortho.tif')
	patch = make_patch(
		1,
		'20_0_0',
		deadwood_validated=True,
		reference_deadwood_label_id=7,
		geometry=utm_square_as_wgs84(*UTM_BBOX),
	)
	patch.update(
		{
			'epsg_code': UTM_EPSG,
			'utm_zone': '32N',
			'bbox_minx': UTM_BBOX[0],
			'bbox_miny': UTM_BBOX[1],
			'bbox_maxx': UTM_BBOX[2],
			'bbox_maxy': UTM_BBOX[3],
			'effective_deadwood_label_id': 7,
		}
	)
	output_dir = tmp_path / 'export'
	monkeypatch.setattr(
		sys, 'argv', ['export_reference_patches.py', '--output-dir', str(output_dir), '--nginx-url', str(cog_dir)]
	)
	monkeypatch.setattr(export_module, 'login', lambda _user, _password: 'token')
	monkeypatch.setattr(export_module, 'fetch_reference_datasets', lambda _token: [10])
	monkeypatch.setattr(export_module, 'fetch_validated_patches', lambda *_args, **_kwargs: [patch])
	monkeypatch.setattr(export_module, 'fetch_cog_info', lambda *_args: {'cog_path': 'ortho.tif', 'cog_info': {}})
	monkeypatch.setattr(export_module, 'fetch_aoi_geometry', lambda *_args: None)
	monkeypatch.setattr(fetch_module, 'use_client', use_client)
	return export_module.main(), output_dir / '10'


def test_main_fails_patch_and_run_when_geometry_fetch_errors(monkeypatch, tmp_path):
	exit_code, dataset_dir = run_main_with_one_validated_patch(
		monkeypatch,
		tmp_path,
		lambda _token: _failing_use_client({}, {'reference_patch_deadwood_geometries'}),
	)

	assert exit_code == 1
	assert not (dataset_dir / 'geotiff' / '10_0_0_20cm_deadwood_ref.tif').exists()
	assert not (dataset_dir / 'metadata' / '10_0_0_20cm.json').exists()


def test_main_exports_mask_when_geometry_fetch_succeeds(monkeypatch, tmp_path):
	import rasterio

	minx, miny, maxx, maxy = UTM_BBOX
	tables = {
		'reference_patch_deadwood_geometries': [
			{
				'id': 1,
				'patch_id': 1,
				'label_id': 7,
				'geometry': utm_square_as_wgs84(minx, miny, (minx + maxx) / 2, maxy),
				'created_at': '2026-04-09T10:00:00+00:00',
			}
		]
	}
	exit_code, dataset_dir = run_main_with_one_validated_patch(
		monkeypatch, tmp_path, lambda _token: FakeUseClient(tables)
	)

	assert exit_code == 0
	with rasterio.open(dataset_dir / 'geotiff' / '10_0_0_20cm_deadwood_ref.tif') as mask:
		assert 0.45 < (mask.read(1) > 0).mean() < 0.55


def test_main_exits_non_zero_when_reference_dataset_fetch_fails(monkeypatch, tmp_path):
	monkeypatch.setattr(sys, 'argv', ['export_reference_patches.py', '--output-dir', str(tmp_path)])
	monkeypatch.setattr(export_module, 'login', lambda _user, _password: 'token')
	monkeypatch.setattr(fetch_module, 'use_client', lambda _token: _failing_use_client({}, {'reference_datasets'}))

	assert export_module.main() == 1


def test_main_fails_when_vector_freshness_check_errors_and_nothing_else_changed(monkeypatch, tmp_path):
	patch = make_patch(1, '20_0_0', deadwood_validated=True, reference_deadwood_label_id=7)

	def fail_timestamp_fetch(*_args, **_kwargs):
		raise RuntimeError('database unavailable')

	monkeypatch.setattr(sys, 'argv', ['export_reference_patches.py', '--output-dir', str(tmp_path)])
	monkeypatch.setattr(export_module, 'login', lambda _user, _password: 'token')
	monkeypatch.setattr(export_module, 'fetch_reference_datasets', lambda _token: [10])
	monkeypatch.setattr(export_module, 'fetch_validated_patches', lambda *_args, **_kwargs: [patch])
	monkeypatch.setattr(export_module, 'get_vector_export_candidates', lambda patches, **_kwargs: list(patches))
	monkeypatch.setattr(export_module, 'patch_needs_export', lambda *_args, **_kwargs: False)
	monkeypatch.setattr(export_module, 'fetch_latest_reference_geometry_created_at', fail_timestamp_fetch)
	monkeypatch.setattr(export_module, 'cleanup_removed_datasets', lambda *_args, **_kwargs: None)
	monkeypatch.setattr(export_module, 'cleanup_removed_patch_exports', lambda *_args, **_kwargs: 0)

	assert export_module.main() == 1
