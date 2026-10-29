import json

import numpy as np
import pytest
import rasterio
from rasterio.io import MemoryFile
from rasterio.transform import from_origin
from shapely.geometry import box

from processor.src.prediction_quality_v1 import judge, rule, tiles
from processor.src.prediction_quality_v1.render import CROP_PX, judge_images, render_crop

pytestmark = pytest.mark.unit

EPSG = 32632  # UTM 32N
X0, Y0 = 400000.0, 5300000.0  # origin of the synthetic ortho


def _answer(dw_major=10, fc_major=10, verdict='ok'):
	modes = lambda layer: {k: {'likelihood': 5, 'area_pct': 1} for k in judge.MODES[layer]}  # noqa: E731
	return json.dumps(
		{
			'assessable': True,
			'deadwood': {'errors': [], 'modes': modes('deadwood'), 'verdict': verdict, 'major_likelihood': dw_major},
			'forest': {'errors': ['gaps'], 'modes': modes('forest'), 'verdict': verdict, 'major_likelihood': fc_major},
		}
	)


def test_prompt_asks_every_mode_once_and_never_m8():
	for layer in judge.MODES.values():
		for mode in layer:
			assert judge.PROMPT.count(f'"{mode}"') == 1
	assert 'm8' not in judge.PROMPT
	assert 'lying trunks, logs and debris are never deadwood' in judge.PROMPT


def test_parse_reads_modes_and_rejects_bad_answers():
	a = judge.parse('haiku', 'Here you go: ' + _answer(dw_major=80, verdict='major'))
	assert a.layers['deadwood'].verdict == 'major'
	assert a.layers['deadwood'].major_likelihood == 80
	assert a.layers['forest'].area_pct == len(judge.MODES['forest'])
	with pytest.raises(judge.AnswerError):
		judge.parse('haiku', 'no json here')
	with pytest.raises(judge.AnswerError):
		judge.parse('haiku', _answer(verdict='terrible'))
	with pytest.raises(judge.AnswerError):
		judge.parse('haiku', _answer(dw_major=140))


def test_ask_retries_a_malformed_answer_once():
	replies = iter(['oops', _answer(dw_major=30)])
	a = judge.ask('luna', lambda prompt, images: next(replies), [])
	assert a.layers['deadwood'].major_likelihood == 30


def test_combined_averages_judges():
	answers = [judge.parse('luna', _answer(dw_major=40)), judge.parse('haiku', _answer(dw_major=80))]
	c = judge.combined(answers, 'deadwood')
	assert c == {'major_likelihood': 60, 'area_pct': len(judge.MODES['deadwood']), 'judges': 2}


def _tile(i, dw, fc):
	t = tiles.Tile(tile_id=i, pixel_window=(0, 0, 512, 512), bbox_4326=(0, 0, 0, 0))
	t.deadwood_share, t.forest_share = dw, fc
	return t


def test_exclude_set_takes_most_covered_tiles():
	ts = [_tile(i, dw=i / 100, fc=0.1) for i in range(30)]
	chosen = tiles.exclude_set(ts, n=10)
	assert [t.tile_id for t in chosen] == list(range(29, 19, -1))
	assert all('exclude' in t.sets for t in chosen)


def test_training_set_is_deterministic_stratified_and_weighted():
	ts = [_tile(i, dw=0.3 if i < 3 else 0.0, fc=0.8 if i % 2 else 0.2) for i in range(120)]
	a = [t.tile_id for t in tiles.training_set(ts, 20, seed=7)]
	ts2 = [_tile(i, dw=0.3 if i < 3 else 0.0, fc=0.8 if i % 2 else 0.2) for i in range(120)]
	b = [t.tile_id for t in tiles.training_set(ts2, 20, seed=7)]
	assert a == b and len(a) == 20
	chosen = [t for t in ts if 'training' in t.sets]
	assert abs(sum(t.weight for t in chosen) - 1) < 1e-9
	rare = [t for t in chosen if t.stratum[0] == 3]
	assert rare, 'the rare high-deadwood stratum gets crops'
	# Its weight per crop stays below its oversampled count share: weights restore area shares.
	assert sum(t.weight for t in rare) < 0.1


def test_crop_count_and_split_are_stable():
	assert tiles.crop_count(4) == 10 and tiles.crop_count(30) == 15 and tiles.crop_count(500) == 40
	assert tiles.benchmark_split(1234) == tiles.benchmark_split(1234)
	assert {tiles.benchmark_split(i) for i in range(200)} == {'development', 'holdout'}


def test_dataset_rule_counts_major_crops_in_the_exclude_set():
	major = {'major_likelihood': 90, 'area_pct': 30, 'judges': 2}
	fine = {'major_likelihood': 5, 'area_pct': 0, 'judges': 2}
	v = rule.dataset_verdict('forest', [{'combined': major}, {'combined': major}] + [{'combined': fine}] * 8)
	assert v['verdict'] == 'bad' and v['major_crops'] == 2 and v['rule'] == rule.RULE_VERSION
	v = rule.dataset_verdict(
		'forest', [{'combined': major}] + [{'combined': fine}] * 9, [{'combined': major, 'weight': 0.25}, {'combined': fine, 'weight': 0.75}]
	)
	assert v['verdict'] == 'ok' and v['training_major_share'] == 0.25
	assert rule.dataset_verdict('forest', [{'combined': {'major_likelihood': None}}])['verdict'] is None


def _ortho(res=0.02, size=3000):
	"""A synthetic UTM ortho: grey ground with a bright square of 10 x 10 m."""
	data = np.full((3, size, size), 90, 'uint8')
	data[:, 500:1000, 500:1000] = 220
	mem = MemoryFile()
	with mem.open(
		driver='GTiff', width=size, height=size, count=3, dtype='uint8', crs=f'EPSG:{EPSG}',
		transform=from_origin(X0, Y0 + size * res, res, res),
	) as dst:
		dst.write(data)
	return mem


def test_render_crop_warps_the_square_and_rasterises_overlays():
	mem = _ortho()
	square = (X0 + 5, Y0 + 5, X0 + 5 + tiles.TILE_M, Y0 + 5 + tiles.TILE_M)
	dead = box(square[0], square[1], square[0] + tiles.TILE_M / 2, square[3])  # left half
	aoi = box(square[0], square[1], square[2], square[1] + tiles.TILE_M * 0.75)  # lower three quarters
	with mem.open() as src:
		crop = render_crop(src, EPSG, square, {'deadwood': [dead], 'forest': []}, aoi)
	assert crop.rgb.shape == (CROP_PX, CROP_PX, 3)
	assert crop.valid_fraction == pytest.approx(1.0, abs=0.01)
	assert crop.cover('deadwood') == pytest.approx(0.5, abs=0.01)
	assert crop.cover('forest') == 0
	raw, dw, fc = judge_images(crop)
	top, bottom = np.asarray(raw)[10, 10], np.asarray(raw)[-10, 10]
	assert top.mean() < bottom.mean(), 'outside the AOI is darkened'
	assert np.asarray(dw)[-10, 10, 2] > np.asarray(raw)[-10, 10, 2], 'deadwood fill tints blue'


def test_attach_cover_measures_shares_on_the_tile_square():
	from pyproj import Transformer

	to_wgs = Transformer.from_crs(EPSG, 4326, always_xy=True)
	sq = (X0, Y0, X0 + tiles.TILE_M, Y0 + tiles.TILE_M)
	lon0, lat0 = to_wgs.transform(sq[0], sq[1])
	lon1, lat1 = to_wgs.transform(sq[2], sq[3])
	t = tiles.Tile(tile_id=1, pixel_window=(0, 0, 512, 512), bbox_4326=(lon0, lat0, lon1, lat1))
	half = box(*to_wgs.transform(sq[0], sq[1]), *to_wgs.transform(sq[0] + tiles.TILE_M / 2, sq[3]))
	tiles.attach_cover([t], EPSG, [half], [])
	assert t.square_utm[0] == pytest.approx(sq[0], abs=0.5)
	assert t.deadwood_share == pytest.approx(0.5, abs=0.05) and t.forest_share == 0


def test_store_rows_follow_the_audit_base_tables():
	from processor.src.prediction_quality_v1 import store
	from processor.src.prediction_quality_v1.check import CheckResult, CropResult

	mem = _ortho()
	square = (X0 + 5, Y0 + 5, X0 + 5 + tiles.TILE_M, Y0 + 5 + tiles.TILE_M)
	with mem.open() as src:
		crop = render_crop(src, EPSG, square, {'deadwood': [], 'forest': []})
	t = _tile(7, dw=0.1, fc=0.5)
	t.sets, t.weight = ['exclude', 'training'], 0.2
	answers = [judge.parse('luna-medium', _answer(dw_major=70, verdict='major'))]
	r = CropResult(tile=t, crop=crop, answers=answers, combined={'deadwood': judge.combined(answers, 'deadwood')})
	result = CheckResult(dataset_id=42, epsg=EPSG, crops=[r], verdicts={'deadwood': {}, 'forest': {}}, tiles_total=9, seconds=1)
	labels = {'deadwood': 11, 'forest': 12}
	crops = store.crop_rows(result, 'abc', lambda tile: {'type': 'Polygon', 'coordinates': []})
	assert [c['crop_set'] for c in crops] == ['exclude', 'training']
	assert crops[0]['selection']['weight'] is None and crops[1]['selection']['weight'] == 0.2
	images = store.image_rows(result, labels)
	assert [(i['kind'], i['label_id']) for i in images] == [
		('raw', None), ('deadwood_overlay', 11), ('forest_cover_overlay', 12)
	]
	rows = store.assessment_rows(result, labels)
	assert [(x['layer'], x['label_id'], x['verdict']) for x in rows] == [
		('image', None, 'ok'), ('deadwood', 11, 'major'), ('forest_cover', 12, 'major')
	]
	assert rows[1]['modes']['m1_dead_missed'] == {'likelihood': 5.0, 'area_pct': 1.0}
	run = store.run_row(result, 'abc', labels, {'luna-medium': 'gpt-6-luna'})
	assert run['check_key'] == 'prediction_quality' and run['coverage']['training_set'] == 1
