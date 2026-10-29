import json
import math
import sys
import types

import numpy as np
import pytest

from processor.src.utils import odm_split, odm_split_submodels
from processor.src.utils.odm_split import SplitPlan, missing_piece_orthophotos, plan_split, split_odm_command
from processor.src.utils.ortho_resolution import MissionExtent

pytestmark = pytest.mark.unit

DOWN = [math.pi, 0.0, 0.0]


def test_missions_up_to_the_threshold_render_whole():
	assert plan_split(MissionExtent(2000, 2000, 2.5), 2000, 4.0, 2.5) is None
	assert plan_split(MissionExtent(1630, 1252, 3.0), 2582, 4.0, 2.5) is None


@pytest.mark.parametrize(
	'width_m, height_m, shots, pieces, shots_per_piece',
	[
		(3029, 2607, 1255, 4, 314),  # 8463: 7.9 km²
		(1803, 3473, 2085, 3, 695),  # 8935: 6.3 km²
		(2095, 2085, 2219, 2, 1110),  # 9212: 4.4 km²
	],
)
def test_large_missions_split_into_pieces_of_about_the_target_area(width_m, height_m, shots, pieces, shots_per_piece):
	plan = plan_split(MissionExtent(width_m, height_m, 2.5), shots, 4.0, 2.5)

	assert (plan.pieces, plan.shots_per_piece) == (pieces, shots_per_piece)
	assert plan.area_km2 == pytest.approx(width_m * height_m / 1e6)


def test_a_sparse_mission_gets_no_more_pieces_than_its_shots_can_fill():
	assert plan_split(MissionExtent(5000, 5000, 10.0), 7, 4.0, 2.5).pieces == 2
	assert plan_split(MissionExtent(5000, 5000, 10.0), 5, 4.0, 2.5) is None


def test_split_command_turns_on_split_merge_without_alignment():
	command = ['--fast-orthophoto', '--orthophoto-resolution', '3.1', '--project-path', '/odm_data', 'dataset_1']

	split = split_odm_command(command, SplitPlan(area_km2=7.9, pieces=4, shots_per_piece=314), 150.0)

	assert split == ['--split', '314', '--split-overlap', '150', '--sm-no-align', '--rerun-from', 'merge', *command]


def test_missing_piece_orthophotos_names_pieces_without_orthophoto_or_cutline(monkeypatch):
	existing = {
		'dataset_1/submodels/submodel_0000/odm_orthophoto/odm_orthophoto_feathered.tif',
		'dataset_1/submodels/submodel_0000/odm_orthophoto/odm_orthophoto_cut.tif',
		'dataset_1/submodels/submodel_0001/odm_orthophoto/odm_orthophoto_feathered.tif',
	}
	monkeypatch.setattr(odm_split, 'path_exists_on_shared_volume', lambda volume, path, dataset_id: path in existing)

	missing = missing_piece_orthophotos('odm_processing_1', 'dataset_1', SplitPlan(5.0, 3, 10), dataset_id=1)

	assert missing == ['submodel_0001', 'submodel_0002']


def test_camera_center_inverts_the_opensfm_pose():
	assert odm_split_submodels.camera_center({'rotation': DOWN, 'translation': [0, 0, 60]}) == pytest.approx([0, 0, 60])
	assert odm_split_submodels.camera_center({'rotation': [0, 0, 0], 'translation': [-5, 2, 1]}) == pytest.approx(
		[5, -2, -1]
	)


def test_pieces_take_in_neighbours_within_the_overlap():
	positions = np.array([[0, 0], [10, 0], [100, 0], [110, 0]], dtype=np.float32)
	labels = np.array([0, 0, 1, 1])

	assert odm_split_submodels.pieces_with_overlap(positions, labels, 5.0) == [[0, 1], [2, 3]]
	assert odm_split_submodels.pieces_with_overlap(positions, labels, 95.0) == [[0, 1, 2], [1, 2, 3]]


def test_piece_reconstructions_keep_their_shots_and_the_points_they_observe():
	reconstructions = [
		{'cameras': {'c': {}}, 'shots': {'a': {}, 'b': {}}, 'points': {'pa': {}, 'pb': {}, 'pab': {}}},
		{'cameras': {'c': {}}, 'shots': {'z': {}}, 'points': {'pz': {}}},
	]
	observations = {'a': {'pa', 'pab'}, 'b': {'pb', 'pab'}, 'z': {'pz'}}

	(piece,) = odm_split_submodels.piece_reconstructions(reconstructions, {'a'}, observations.get)

	assert piece == {'cameras': {'c': {}}, 'shots': {'a': {}}, 'points': {'pa': {}, 'pab': {}}}


def test_split_config_replaces_earlier_values(tmp_path):
	(tmp_path / 'config.yaml').write_text('feature_type: SIFT\nsubmodel_size: 80\n')

	odm_split_submodels._append_config(str(tmp_path), odm_split_submodels.odm_split_config(20, 150.0))

	lines = (tmp_path / 'config.yaml').read_text().splitlines()
	assert lines[0] == 'feature_type: SIFT'
	assert 'submodel_size: 20' in lines and 'submodel_size: 80' not in lines
	assert 'submodel_relpath_template: ../submodels/submodel_%04d/opensfm' in lines


def test_main_hands_every_submodel_its_part_of_the_reconstruction(tmp_path, monkeypatch, capsys):
	"""Runs the script's entry point against fake opensfm modules standing in for the ODM image."""
	opensfm_dir = tmp_path / 'opensfm'
	opensfm_dir.mkdir()
	(opensfm_dir / 'tracks.csv').write_text('tracks')
	shots = {f'west{i}': -100.0 - i for i in range(3)} | {f'east{i}': 100.0 + i for i in range(3)}
	reconstruction = {
		'cameras': {'c': {}},
		'shots': {name: {'rotation': DOWN, 'translation': [-x, 0, 60]} for name, x in shots.items()},
		'points': {f'p_{name}': {} for name in shots},
	}
	(opensfm_dir / 'reconstruction.json').write_text(json.dumps([reconstruction]))
	created = []

	class FakeMetaDataSet:
		def __init__(self, path):
			self.path = path

		def remove_submodels(self):
			pass

		def create_submodels(self, clusters):
			created.extend(clusters)
			for index in range(len(clusters)):
				(tmp_path / 'submodels' / f'submodel_{index:04d}' / 'opensfm').mkdir(parents=True)

		def _submodel_path(self, index):
			return str(tmp_path / 'submodels' / f'submodel_{index:04d}' / 'opensfm')

	tracks = types.SimpleNamespace(get_shot_observations=lambda shot: {f'p_{shot}': object()})
	modules = {
		'opensfm': types.ModuleType('opensfm'),
		'opensfm.dataset': types.SimpleNamespace(
			DataSet=lambda path: types.SimpleNamespace(load_tracks_manager=lambda: tracks)
		),
		'opensfm.large': types.ModuleType('opensfm.large'),
		'opensfm.large.tools': types.SimpleNamespace(
			kmeans=lambda positions, k: (0, (positions[:, 0] > 0).astype(np.int32).reshape(-1, 1), None)
		),
		'opensfm.large.metadataset': types.SimpleNamespace(MetaDataSet=FakeMetaDataSet),
	}
	modules['opensfm.large'].tools = modules['opensfm.large.tools']
	for name, module in modules.items():
		monkeypatch.setitem(sys.modules, name, module)

	odm_split_submodels.main(str(opensfm_dir), 2, 50.0)

	assert [sorted(cluster) for cluster in created] == [['west0', 'west1', 'west2'], ['east0', 'east1', 'east2']]
	(east,) = json.loads((tmp_path / 'submodels/submodel_0001/opensfm/reconstruction.json').read_text())
	assert set(east['shots']) == {'east0', 'east1', 'east2'}
	assert set(east['points']) == {'p_east0', 'p_east1', 'p_east2'}
	assert (tmp_path / 'submodels/submodel_0001/opensfm/tracks.csv').read_text() == 'tracks'
	assert 'submodel_size: 3' in (opensfm_dir / 'config.yaml').read_text()
	assert json.loads(capsys.readouterr().out) == {
		'pieces': [{'shots': 3, 'own_shots': 3, 'points': 3}, {'shots': 3, 'own_shots': 3, 'points': 3}]
	}


def test_main_refuses_pieces_too_small_for_an_orthophoto(tmp_path, monkeypatch):
	opensfm_dir = tmp_path / 'opensfm'
	opensfm_dir.mkdir()
	reconstruction = {'shots': {f's{i}': {'rotation': DOWN, 'translation': [i, 0, 60]} for i in range(5)}}
	(opensfm_dir / 'reconstruction.json').write_text(json.dumps([reconstruction]))
	for name in ('opensfm', 'opensfm.dataset', 'opensfm.large', 'opensfm.large.tools', 'opensfm.large.metadataset'):
		monkeypatch.setitem(sys.modules, name, types.SimpleNamespace(DataSet=None, MetaDataSet=None, tools=None))

	with pytest.raises(SystemExit, match='Cannot cut 5 shots into 2 pieces'):
		odm_split_submodels.main(str(opensfm_dir), 2, 50.0)


def test_split_script_source_is_self_contained():
	"""The processor ships this file's source to python -c in the ODM image: no processor imports."""
	source = open(odm_split_submodels.__file__).read()
	assert 'from processor' not in source and 'import processor' not in source
	assert 'from shared' not in source
