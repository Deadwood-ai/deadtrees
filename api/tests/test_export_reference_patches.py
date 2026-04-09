from types import SimpleNamespace

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
