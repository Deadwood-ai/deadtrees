from contextlib import nullcontext
import json
import re

import numpy as np
import pytest
from rasterio.io import MemoryFile
from rasterio.transform import from_origin
from shapely.geometry import box

from processor.src.prediction_quality_v1 import judge, tiles
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
			'forest': {'errors': ['gaps'], 'modes': modes('forest'), 'verdict': verdict, 'major_likelihood': fc_major, 'summary': 'Gaps are filled.'},
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
	# a reply of the wrong shape is a bad answer (asked again), not a crash
	odd_modes = json.loads(_answer())
	odd_modes['deadwood']['modes'] = ['m1_dead_missed']
	odd_mode = json.loads(_answer())
	odd_mode['forest']['modes']['m5_fc_trees_missed'] = 'high'
	for reply in (None, '{"deadwood": [1], "forest": 2}', json.dumps(odd_mode)):
		with pytest.raises(judge.AnswerError):
			judge.parse('haiku', reply)
	assert judge.parse('haiku', json.dumps(odd_modes)).layers['deadwood'].modes['m1_dead_missed']['likelihood'] == 0


def test_ask_retries_a_malformed_answer_once():
	replies = iter(['oops', _answer(dw_major=30)])
	a = judge.ask('luna', lambda prompt, images: next(replies), [])
	assert a.layers['deadwood'].major_likelihood == 30


def test_a_judge_may_say_it_cannot_assess_the_tile():
	blind = json.loads(_answer(dw_major=100))
	for value in (False, 'false'):
		blind['assessable'] = value
		assert not judge.parse('haiku', json.dumps(blind)).assessable
	assert judge.parse('haiku', _answer()).assessable


def test_a_judge_may_call_a_layer_ambiguous():
	reply = json.loads(_answer())
	reply['forest']['verdict'] = 'ambiguous'
	assert judge.parse('haiku', json.dumps(reply)).layers['forest'].verdict == 'ambiguous'
	assert '"ambiguous"' in judge.PROMPT and judge.PROMPT_VERSION == 'pq-v7'


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


def test_tile_count_follows_the_area():
	assert tiles.tile_count(4) == 10 and tiles.tile_count(30) == 15 and tiles.tile_count(500) == 40


def _ortho(res=0.02, size=3000):
	"""A synthetic UTM ortho: grey ground with a bright square of 10 x 10 m."""
	data = np.full((3, size, size), 90, 'uint8')
	data[:, 500:1000, 500:1000] = 220
	mem = MemoryFile()
	with mem.open(
		driver='GTiff',
		width=size,
		height=size,
		count=3,
		dtype='uint8',
		crs=f'EPSG:{EPSG}',
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
	to_utm = Transformer.from_crs(4326, EPSG, always_xy=True)
	tiles.attach_cover([t], to_utm, tiles.utm_layer([half, None], to_utm), tiles.utm_layer([], to_utm))
	assert t.square_utm[0] == pytest.approx(sq[0], abs=0.5)
	assert t.deadwood_share == pytest.approx(0.5, abs=0.05) and t.forest_share == 0


def test_the_payload_follows_the_audit_tables():
	from processor.src.prediction_quality_v1 import payload
	from processor.src.prediction_quality_v1.check import CheckResult, TileResult

	mem = _ortho()
	square = (X0 + 5, Y0 + 5, X0 + 5 + tiles.TILE_M, Y0 + 5 + tiles.TILE_M)
	with mem.open() as src:
		crop = render_crop(src, EPSG, square, {'deadwood': [], 'forest': []})
	t = _tile(7, dw=0.1, fc=0.5)
	t.pixel_window = (512, 1024, 1024, 1536)
	t.sets, t.weight = ['exclude', 'training'], 0.2
	blind = json.loads(_answer())
	blind['assessable'] = False
	answers = [
		judge.parse('luna-medium', _answer(dw_major=70, verdict='major')),
		judge.parse('haiku-5.5', json.dumps(blind)),
	]
	result = CheckResult(
		dataset_id=42, epsg=EPSG, tiles=[TileResult(tile=t, crop=crop, answers=answers)], tiles_total=9, seconds=1
	)
	footprint = {'type': 'Polygon', 'coordinates': []}
	judged = {'ortho_sha256': 'a' * 64, 'aoi': None, 'label_ids': {'deadwood': 11, 'forest_cover': 12}}
	out, files = payload.build(5, result, inputs=judged, label_ids={'deadwood': 11, 'forest': 12}, footprints={7: footprint})

	assert set(out) == {'inputs', 'evidence', 'tiles', 'images', 'dataset_judgements', 'tile_judgements'}
	assert out['inputs'] == judged and out['dataset_judgements'] == []
	assert out['tiles'] == [{'pixel_window': [512, 1024, 1024, 1536], 'geometry': footprint, 'mpp': crop.mpp, 'size_px': CROP_PX}]
	assert [(i['tile_index'], i['kind'], i['prediction_label_id']) for i in out['images']] == [
		(1, 'raw', None),
		(1, 'deadwood_overlay', 11),
		(1, 'forest_cover_overlay', 12),
	]
	# one folder per run; the files are uploaded before finish_run stores the rows
	assert out['images'][1]['storage_path'] == 'audit/prediction_quality/42/run-5/tile-512-1024/deadwood_overlay-11.jpg'
	assert [path for path, _ in files] == [i['storage_path'] for i in out['images']]
	rows = out['tile_judgements']
	assert [(r['tile_index'], r['judge'], r['layer'], r['verdict']) for r in rows] == [
		(1, 'luna-medium', 'deadwood', 'major'),
		(1, 'luna-medium', 'forest_cover', 'major'),
		(1, 'haiku-5.5', 'deadwood', 'not_assessable'),
		(1, 'haiku-5.5', 'forest_cover', 'not_assessable'),
	]
	assert rows[0]['problems']['m1_dead_missed'] == {'likelihood': 5.0, 'area_pct': 1.0} and rows[0]['likelihood'] == 70
	# the layer's summary for data users; an answer without one has none
	assert rows[1]['summary'] == 'Gaps are filled.' and rows[0]['summary'] is None
	assert rows[2]['raw'] == {'assessable': False, 'verdict': 'ok', 'errors': []}
	assert set(rows[0]) == {'tile_index', 'layer', 'judge', 'verdict', 'likelihood', 'problems', 'summary', 'raw'}
	evidence = out['evidence']
	assert evidence['coverage'] == {'mode': 'sampled', 'tiles_total': 9, 'tiles': 1, 'exclude_set': 1, 'training_set': 1}
	assert evidence['tiles'][0]['sets'] == ['exclude', 'training'] and evidence['tiles'][0]['weight'] == 0.2
	assert evidence['failed_calls'] == 0 and 'rule' not in evidence['versions']
	assert not any('a' * 64 in json.dumps(row) for row in out['tiles'] + out['images'])
	json.dumps(out)  # the RPC argument must serialise


class _FakeTable:
	"""Just enough of the Supabase query builder to serve the handler's reads; it writes nothing."""

	def __init__(self, db, name):
		self.db, self.name, self.filters = db, name, []
		self.after, self.cap, self.span = None, None, None

	def select(self, *_):
		return self

	def or_(self, expression):
		# the one shape shared.pagination.iter_pages_by_creation sends
		at, same, row_id = re.fullmatch(
			r'created_at\.gt\."(.+)",and\(created_at\.eq\."(.+)",id\.gt\.(\d+)\)', expression
		).groups()
		assert at == same
		self.after = (at, int(row_id))
		return self

	def order(self, *_, **__):
		return self

	def limit(self, n):
		self.cap = n
		return self

	def range(self, start, end):
		self.span = (start, end)
		return self

	def eq(self, column, value):
		self.filters.append((column, value))
		return self

	def execute(self):
		from types import SimpleNamespace

		found = [r for r in self.db.get(self.name, []) if all(r.get(c) == v for c, v in self.filters)]
		if self.after:
			found = [r for r in found if (r['created_at'], r['id']) > self.after]
		if self.span:
			found = found[self.span[0] : self.span[1] + 1]
		return SimpleNamespace(data=found[: self.cap])


class _FakeClient:
	def __init__(self, db=None):
		self.db = db or {}

	def table(self, name):
		return _FakeTable(self.db, name)


# ---------------------------------------------------------------------------
# The check end to end and the worker handler, with PostgREST, storage and the judges faked
# ---------------------------------------------------------------------------

SHA = 'c' * 64
OFFSETS = ((5, 5), (60, 5), (5, 60), (60, 60))  # four 51.2 m tiles on a 150 m ortho


def _squares():
	return [(X0 + dx, Y0 + dy, X0 + dx + tiles.TILE_M, Y0 + dy + tiles.TILE_M) for dx, dy in OFFSETS]


def _to_wgs(geom):
	from pyproj import Transformer

	return tiles.project(geom, Transformer.from_crs(EPSG, 4326, always_xy=True))


def _check_tiles():
	return [
		tiles.Tile(tile_id=n + 1, pixel_window=(512 * n, 0, 512 * (n + 1), 512), bbox_4326=_to_wgs(box(*sq)).bounds)
		for n, sq in enumerate(_squares())
	]


@pytest.fixture
def ortho_file(tmp_path):
	path = tmp_path / 'ortho.tif'
	path.write_bytes(_ortho(res=0.05).read())
	return str(path)


def test_a_dataset_without_an_aoi_is_judged_on_all_its_tiles(ortho_file):
	from processor.src.prediction_quality_v1.check import run_prediction_quality

	judges = {'luna-medium': lambda prompt, images: _answer(dw_major=80), 'haiku-5.5': lambda *_: _answer()}
	dead = _to_wgs(box(*_squares()[0]))
	predictions = lambda: {'deadwood': [dead], 'forest': []}  # noqa: E731 (the check empties the dict)
	result = run_prediction_quality(42, ortho_file, _check_tiles(), None, predictions(), judges)
	assert result.tiles_total == 4 and len(result.tiles) == 4
	assert all(r.crop.in_aoi is None and len(r.answers) == 2 for r in result.tiles)
	assert result.cost['haiku-5.5']['calls'] == 4 and result.cost['luna-medium']['cost_usd'] is None
	# an AOI limits the check to the tiles inside it
	inside = run_prediction_quality(42, ortho_file, _check_tiles(), _to_wgs(box(*_squares()[0])), predictions(), judges)
	assert inside.tiles_total == 1 and [r.tile.tile_id for r in inside.tiles] == [1]
	# an AOI smaller than a tile is judged on the tile it touches, not left without tiles
	corner = box(*_squares()[1]).centroid.buffer(5)
	small = run_prediction_quality(
		42, ortho_file, _check_tiles(), _to_wgs(corner), {'deadwood': [], 'forest': []}, judges
	)
	assert [r.tile.tile_id for r in small.tiles] == [2]


def test_login_and_limit_errors_reach_the_worker_and_other_errors_stay_with_the_tile(ortho_file):
	from processor.src.audit_worker.models import LimitReached, LoginExpired
	from processor.src.prediction_quality_v1.check import run_prediction_quality

	def expired(prompt, images):
		raise LoginExpired('claude', 'please run /login')

	def limited(prompt, images):
		raise LimitReached('codex', 'usage limit')

	def broken(prompt, images):
		raise RuntimeError('boom')

	once = [True]

	def flaky(prompt, images):
		if once:
			once.pop()
			raise RuntimeError('boom')
		return _answer()

	good = lambda prompt, images: _answer()  # noqa: E731
	none = lambda: {'deadwood': [], 'forest': []}  # noqa: E731
	for failing, error in ((expired, LoginExpired), (limited, LimitReached)):
		with pytest.raises(error):
			run_prediction_quality(42, ortho_file, _check_tiles(), None, none(), {'a': good, 'b': failing})
	result = run_prediction_quality(42, ortho_file, _check_tiles(), None, none(), {'a': good, 'b': flaky})
	failed = [r for r in result.tiles if r.failures]
	assert len(failed) == 1 and 'boom' in failed[0].failures['b'] and len(failed[0].answers) == 1
	# a judge that answers no tile fails the run
	with pytest.raises(RuntimeError, match='b answered no tile: RuntimeError: boom'):
		run_prediction_quality(42, ortho_file, _check_tiles(), None, none(), {'a': good, 'b': broken})


def _dataset(aois=()):
	from shared.models import DEFAULT_MODEL_PREFERENCES, LabelDataEnum

	polygon = lambda geom: {'type': 'Polygon', 'coordinates': [list(geom.exterior.coords)]}  # noqa: E731
	label = lambda id, data, **kw: {  # noqa: E731
		'id': id,
		'dataset_id': 42,
		'label_source': 'model_prediction',
		'is_active': True,
		'label_data': data.value,
		'model_config': dict(DEFAULT_MODEL_PREFERENCES[data]),
		**kw,
	}
	squares = _squares()
	tables = {
		'v2_cogs': [
			{'dataset_id': 42, 'cog_file_name': 'c.tif', 'cog_path': 'c.tif', 'version': 1, 'cog_file_size': 1}
		],
		'v2_orthos': [{'dataset_id': 42, 'sha256': SHA}],
		'v2_aois': list(aois),
		'v2_tile_embeddings': [
			{
				'id': n + 1,
				'dataset_id': 42,
				'pixel_x0': 512 * n,
				'pixel_y0': 0,
				'pixel_x1': 512 * (n + 1),
				'pixel_y1': 512,
				'geometry': polygon(_to_wgs(box(*sq))),
			}
			for n, sq in enumerate(squares)
		],
		'v2_labels': [
			label(10, LabelDataEnum.deadwood),  # an older prediction of the preferred model
			label(11, LabelDataEnum.deadwood),
			label(12, LabelDataEnum.forest_cover),
			label(13, LabelDataEnum.forest_cover, model_config={'module': 'another_model'}),
			label(14, LabelDataEnum.forest_cover, is_active=False),
		],
		'v2_deadwood_geometries': [
			{'id': 1, 'label_id': 11, 'is_deleted': False, 'geometry': polygon(_to_wgs(box(*squares[0])))},
			{'id': 2, 'label_id': 11, 'is_deleted': True, 'geometry': polygon(_to_wgs(box(*squares[1])))},
			{'id': 3, 'label_id': 10, 'is_deleted': False, 'geometry': polygon(_to_wgs(box(*squares[2])))},
		],
		'v2_forest_cover_geometries': [],
	}
	for row in tables['v2_deadwood_geometries']:
		row['created_at'] = '2026-11-01T10:00:00+00:00'
	return tables


def test_the_handler_judges_the_preferred_predictions_and_returns_the_run(ortho_file, monkeypatch):
	from types import SimpleNamespace

	from processor.src.audit_worker import worker
	from processor.src.prediction_quality_v1 import handler

	monkeypatch.setattr(handler, 'readable_cog', lambda *args: nullcontext(str(ortho_file)))
	client, stored, refreshed = _FakeClient(_dataset()), {}, []
	judges = {
		'luna-medium': lambda prompt, images: _answer(dw_major=80, verdict='major'),
		'haiku-5.5': lambda prompt, images: _answer(dw_major=70, verdict='major'),
	}
	ctx = SimpleNamespace(
		run={'id': 5, 'dataset_id': 42},
		refresh=lambda: refreshed.append(len(stored)),
		client=client,
		judges=judges,
		token='t',
		put_image=lambda path, data, dataset_id: stored.__setitem__(path, (dataset_id, len(data))),
	)
	out = handler.handle(ctx)
	labels = {'deadwood': 11, 'forest_cover': 12}
	assert out['inputs'] == {'ortho_sha256': SHA, 'aoi': None, 'label_ids': labels}
	assert out['evidence']['coverage'] == {
		'mode': 'sampled',
		'tiles_total': 4,
		'tiles': 4,
		'exclude_set': 4,
		'training_set': 4,
	}
	assert out['evidence']['cost']['luna-medium']['calls'] == 4
	assert len(out['tiles']) == 4 and len(stored) == 12 and len(out['images']) == 12
	assert set(stored) == {i['storage_path'] for i in out['images']}
	assert all(dataset_id == 42 for dataset_id, _ in stored.values())
	rows = out['tile_judgements']
	# tile answers only (deadwood and forest per tile and judge): no dataset verdict
	assert len(rows) == 4 * 2 * 2 and out['dataset_judgements'] == []
	assert {i['prediction_label_id'] for i in out['images'] if i['kind'] == 'forest_cover_overlay'} == {12}
	assert refreshed == [0], 'the login is renewed before the uploads'
	# only the newest preferred prediction is drawn, without its deleted polygons
	covered = {t['pixel_window'][0]: t['predicted']['deadwood'] for t in out['evidence']['tiles']}
	assert covered[0] == pytest.approx(1, abs=0.05) and covered[512] == covered[1024] == 0
	assert out['tiles'][0]['geometry']['type'] == 'Polygon'
	assert worker.HANDLERS['prediction_quality'] == handler.__name__
	assert handler.CONFIG['models'].keys() == judges.keys()
	assert (handler.RULES, handler.RULES_CONFIG) == ('rules-v1', {'decider': 'haiku'})
	assert not {'rule', 'rule_config'} & set(handler.CONFIG)


def test_a_run_needs_the_preferred_predictions_and_a_new_aoi_is_other_inputs():
	from processor.src.prediction_quality_v1 import handler

	tables = _dataset()
	tables['v2_labels'] = [row for row in tables['v2_labels'] if row['id'] != 12]
	with pytest.raises(ValueError, match='no forest_cover prediction'):
		handler.prediction_labels(_FakeClient(tables), 42)
	aoi = {'geometry': {'type': 'Polygon', 'coordinates': [[[0, 0], [1, 0], [1, 1], [0, 0]]]}, 'source': 'manual'}
	labels = {'deadwood': 11, 'forest': 12}
	assert handler.identity(SHA, aoi, labels)['aoi'] and handler.identity(SHA, aoi, labels) != handler.identity(SHA, None, labels)


def test_a_forest_that_fills_the_crop_is_framed_and_its_share_is_in_the_prompt():
	"""DT-1560: a full-cover forest overlay had no edge, and the judges reported the forest missing."""
	from processor.src.prediction_quality_v1.render import Crop, outline, overlay

	full = np.ones((8, 8), bool)
	frame = outline(full, 2)
	assert frame[0].all() and frame[:, -1].all() and frame[1, 1:-1].all(), 'the crop border is outlined'
	assert not frame[2:-2, 2:-2].any(), 'the inside stays fill only'

	rgb = np.full((CROP_PX, CROP_PX, 3), 100, 'uint8')
	crop = Crop(rgb=rgb, valid=np.ones((CROP_PX, CROP_PX), bool), masks={'deadwood': np.zeros((CROP_PX, CROP_PX), bool), 'forest': np.ones((CROP_PX, CROP_PX), bool)}, mpp=0.05)
	fc = np.asarray(overlay(crop, 'forest'))
	assert tuple(fc[0, 500]) == (255, 202, 50), 'gold frame at the border'
	assert fc[500, 500, 0] > 150, 'clearly gold inside'

	prompt = judge.prompt_for({'deadwood': 0.004, 'forest': 0.97})
	assert 'deadwood covers 0% of the crop, forest covers 97%' in prompt
	assert '{cover}' not in prompt and '{cover}' in judge.PROMPT
	seen = []
	judge.ask('luna', lambda p, images: seen.append(p) or _answer(), [], cover={'deadwood': 0.1, 'forest': 0.5})
	assert 'forest covers 50%' in seen[0]


def test_a_run_queued_for_the_older_version_fails_instead_of_being_judged_with_this_drawing():
	from types import SimpleNamespace

	from processor.src.prediction_quality_v1 import handler

	ctx = SimpleNamespace(run={'id': 5, 'dataset_id': 42}, version={'version': 'v1', 'config': {}})
	with pytest.raises(ValueError, match='the run is of version v1; this code judges v2'):
		handler.handle(ctx)
