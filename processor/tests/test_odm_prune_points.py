import json
import sys
import types

import pytest

from processor.src.utils import odm_prune_points

pytestmark = pytest.mark.unit


class _FakeTracksManager:
	def __init__(self, observations: dict[str, dict]):
		self.observations = observations

	def get_shot_observations(self, shot_id):
		return self.observations.get(shot_id, {})


def test_unobserved_point_ids():
	reconstruction = {'points': {'1': {}, '2': {}, '3': {}}}

	assert odm_prune_points.unobserved_point_ids(reconstruction, {'2'}) == ['1', '3']


def test_main_removes_points_only_dropped_shots_observed(tmp_path, monkeypatch, capsys):
	"""Runs the script's entry point against a fake opensfm package standing in for the ODM image."""
	reconstruction = [
		{
			'shots': {'nadir.jpg': {}, 'nadir2.jpg': {}},
			'points': {'shared': {'coordinates': [0, 0, 0]}, 'nadir_only': {}, 'oblique_only': {}},
			'cameras': {'cam': {}},
		}
	]
	(tmp_path / 'reconstruction.json').write_text(json.dumps(reconstruction))
	tracks = _FakeTracksManager(
		{
			'nadir.jpg': {'shared': object(), 'nadir_only': object()},
			'nadir2.jpg': {'shared': object()},
			'oblique.jpg': {'shared': object(), 'oblique_only': object()},
		}
	)
	dataset_module = types.ModuleType('opensfm.dataset')
	dataset_module.DataSet = lambda path: types.SimpleNamespace(load_tracks_manager=lambda: tracks)
	monkeypatch.setitem(sys.modules, 'opensfm', types.ModuleType('opensfm'))
	monkeypatch.setitem(sys.modules, 'opensfm.dataset', dataset_module)

	odm_prune_points.main(str(tmp_path))

	(pruned,) = json.loads((tmp_path / 'reconstruction.json').read_text())
	assert set(pruned['points']) == {'shared', 'nadir_only'}
	assert pruned['shots'] == reconstruction[0]['shots']
	assert json.loads(capsys.readouterr().out) == {'removed_points': 1, 'total_points': 3}


def test_script_source_is_self_contained():
	"""The processor ships this file's source to python -c in the ODM image: no processor imports."""
	source = open(odm_prune_points.__file__).read()
	assert 'from processor' not in source and 'import processor' not in source
	assert 'from shared' not in source
