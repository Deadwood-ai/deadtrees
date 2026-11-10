import json
import re

import numpy as np
import pytest
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


def test_combined_averages_judges():
	answers = [judge.parse('luna', _answer(dw_major=40)), judge.parse('haiku', _answer(dw_major=80))]
	c = judge.combined(answers, 'deadwood')
	assert c == {'major_likelihood': 60, 'area_pct': len(judge.MODES['deadwood']), 'judges': 2}
	# a judge that could not assess the crop does not count
	blind = json.loads(_answer(dw_major=100))
	for value in (False, 'false'):
		blind['assessable'] = value
		answers[1] = judge.parse('haiku', json.dumps(blind))
		assert not answers[1].assessable and judge.combined(answers, 'deadwood')['major_likelihood'] == 40
	assert judge.combined(answers[1:], 'deadwood')['major_likelihood'] is None


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


def test_crop_count_follows_the_area():
	assert tiles.crop_count(4) == 10 and tiles.crop_count(30) == 15 and tiles.crop_count(500) == 40


def test_dataset_rule_counts_major_crops_in_the_exclude_set():
	major = {'major_likelihood': 90, 'area_pct': 30, 'judges': 2}
	fine = {'major_likelihood': 5, 'area_pct': 0, 'judges': 2}
	v = rule.dataset_verdict('forest', [{'combined': major}, {'combined': major}] + [{'combined': fine}] * 8)
	assert v['verdict'] == 'bad' and v['major_crops'] == 2 and v['rule'] == rule.RULE_VERSION
	v = rule.dataset_verdict(
		'forest',
		[{'combined': major}] + [{'combined': fine}] * 9,
		[{'combined': major, 'weight': 0.25}, {'combined': fine, 'weight': 0.75}],
	)
	assert v['verdict'] == 'ok' and v['training_major_share'] == 0.25
	assert rule.dataset_verdict('forest', [{'combined': {'major_likelihood': None}}])['verdict'] is None
	# a version runs with the cuts it was registered with
	strict = {'crop_major_cut': {'deadwood': 52.0, 'forest': 95.0}, 'min_major_crops': 1}
	assert rule.dataset_verdict('forest', [{'combined': major}] * 3, config=strict)['verdict'] == 'ok'
	assert rule.dataset_verdict('deadwood', [{'combined': major}], config=strict)['verdict'] == 'bad'


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
	result = CheckResult(
		dataset_id=42, epsg=EPSG, crops=[r], verdicts={'deadwood': {}, 'forest': {}}, tiles_total=9, seconds=1
	)
	labels = {'deadwood': 11, 'forest': 12}
	crop_row = store.crop_row(r, 42, 'abc', {'type': 'Polygon', 'coordinates': []})
	assert crop_row['crop_sets'] == ['exclude', 'training']
	assert 'weight' not in crop_row['selection']['exclude'] and crop_row['selection']['training']['weight'] == 0.2
	images = store.image_rows(r, 3, 42, 'abc', labels)
	assert [(i['kind'], i['label_id'], i['crop_id']) for i, _ in images] == [
		('raw', None, 3),
		('deadwood_overlay', 11, 3),
		('forest_cover_overlay', 12, 3),
	]
	rows = store.assessment_rows(r, 3, 5, 42, labels)
	assert [(x['layer'], x['label_id'], x['verdict']) for x in rows] == [
		('image', None, 'ok'),
		('deadwood', 11, 'major'),
		('forest_cover', 12, 'major'),
	]
	assert rows[0]['modes'] == {'m0_not_assessable': {'likelihood': 0}}
	assert rows[1]['modes']['m1_dead_missed'] == {'likelihood': 5.0, 'area_pct': 1.0}
	assert set(crop_row) == {
		'dataset_id',
		'ortho_sha256',
		'crop_sets',
		'pixel_x0',
		'pixel_y0',
		'pixel_x1',
		'pixel_y1',
		'geometry',
		'mpp',
		'size_px',
		'selection',
	}, 'only columns audit.crops has'
	out = store.summary(result)
	assert out['coverage']['training_set'] == 1 and out['evidence']['failed_calls'] == 0


def test_rule_rows_carry_the_dataset_verdict_per_layer():
	from processor.src.prediction_quality_v1 import store
	from processor.src.prediction_quality_v1.check import CheckResult

	verdicts = {
		'deadwood': rule.dataset_verdict('deadwood', []),
		'forest': {'rule': rule.RULE_VERSION, 'verdict': 'bad'},
	}
	result = CheckResult(dataset_id=42, epsg=EPSG, crops=[], verdicts=verdicts, tiles_total=0, seconds=0)
	rows = store.rule_rows(result, 5, {'deadwood': 11, 'forest': 12})
	assert [(r['layer'], r['verdict'], r['assessor_kind'], r['crop_id'], r['run_id']) for r in rows] == [
		('deadwood', 'unsure', 'rule', None, 5),
		('forest_cover', 'major', 'rule', None, 5),
	]
	assert rows[1]['prompt_version'] == rule.RULE_VERSION and rows[1]['label_id'] == 12


class _FakeTable:
	"""Just enough of the Supabase query builder to serve the handler's reads and record its writes."""

	def __init__(self, db, name):
		self.db, self.name, self.op, self.payload, self.filters = db, name, 'select', None, []
		self.after, self.cap, self.span = None, None, None

	def select(self, *_):
		self.op = 'select'
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

	def insert(self, payload):
		self.op, self.payload = 'insert', payload
		return self

	def upsert(self, payload, **_):
		self.op, self.payload = 'upsert', payload
		return self

	def update(self, payload):
		self.op, self.payload = 'update', payload
		return self

	def eq(self, column, value):
		self.filters.append((column, value))
		return self

	def execute(self):
		from types import SimpleNamespace

		rows = self.db.setdefault(self.name, [])
		if self.op == 'select':
			found = [r for r in rows if all(r.get(c) == v for c, v in self.filters)]
			if self.after:
				found = [r for r in found if (r['created_at'], r['id']) > self.after]
			if self.span:
				found = found[self.span[0] : self.span[1] + 1]
			return SimpleNamespace(data=found[: self.cap])
		if self.op in ('insert', 'upsert'):
			batch = self.payload if isinstance(self.payload, list) else [self.payload]
			for r in batch:
				rows.append({'id': len(rows) + 1, **r})
			return SimpleNamespace(data=rows[-len(batch) :])
		self.db.setdefault('updates', []).append((self.name, self.payload, self.filters))
		return SimpleNamespace(data=[])


class _FakeClient:
	def __init__(self, db=None):
		self.db = db or {}

	def schema(self, name):
		assert name == 'audit'
		return self

	def table(self, name):
		return _FakeTable(self.db, name)


def test_write_stores_crops_once_and_links_every_row():
	from processor.src.prediction_quality_v1 import store
	from processor.src.prediction_quality_v1.check import CheckResult, CropResult

	mem = _ortho()
	square = (X0 + 5, Y0 + 5, X0 + 5 + tiles.TILE_M, Y0 + 5 + tiles.TILE_M)
	with mem.open() as src:
		crop = render_crop(src, EPSG, square, {'deadwood': [], 'forest': []})
	t = _tile(7, dw=0.1, fc=0.5)
	t.sets, t.weight = ['exclude'], None
	answers = [judge.parse('luna-medium', _answer())]
	result = CheckResult(
		dataset_id=42,
		epsg=EPSG,
		crops=[CropResult(tile=t, crop=crop, answers=answers)],
		verdicts={'deadwood': {'verdict': 'ok'}, 'forest': {'verdict': None}},
		tiles_total=1,
		seconds=1,
	)
	client, stored = _FakeClient(), {}
	sha = 'a' * 64
	kw = dict(
		ortho_sha256=sha,
		label_ids={'deadwood': 11, 'forest': 12},
		footprints={7: {}},
		put_image=lambda path, data, dataset_id: stored.__setitem__(path, data),
	)
	out = store.write(client, 5, result, **kw)
	assert (out['crops'], out['assessments']) == (1, 5)  # gate + 2 layers + 2 rule rows
	assert out['judged'] == {'crops': [{'crop_id': 1, 'sets': ['exclude'], 'weight': None}], 'images_not_shown': []}
	assert len(stored) == 3 and all(p.startswith(f'audit/prediction_quality/42/{sha[:16]}/crop-1/') for p in stored)
	# a file is named by its content, so another image of the crop never replaces it
	assert all(row['sha256'][:16] in row['storage_path'] for row in client.db['images'])
	assert {r['run_id'] for r in client.db['assessments']} == {5}
	assert {r['crop_id'] for r in client.db['assessments'] if r['assessor_kind'] == 'model'} == {1}
	# A second run on the same ortho reuses the crop and adds its new set.
	t.sets = ['exclude', 'training']
	t.weight = 0.5
	again = store.write(client, 6, result, **kw)
	assert len(client.db['crops']) == 1
	# the images are stored already: nothing is uploaded or inserted twice
	assert len(stored) == 3 and len(client.db['images']) == 3 and again['judged']['images_not_shown'] == []
	# the crop row holds every run's sets; the run says which were its own
	assert again['judged']['crops'] == [{'crop_id': 1, 'sets': ['exclude', 'training'], 'weight': 0.5}]
	crop_updates = client.db['updates']  # the run row stays the worker's
	assert len(crop_updates) == 1 and crop_updates[0][0] == 'crops' and crop_updates[0][2] == [('id', 1)]
	assert crop_updates[0][1]['crop_sets'] == ['exclude', 'training']
	assert set(crop_updates[0][1]['selection']) == {'exclude', 'training'}
	# With another AOI the judges see the crop darkened elsewhere. The stored row stays the
	# first, so the run names the files it judged instead.
	crop.in_aoi = np.zeros(crop.valid.shape, bool)
	other = store.write(client, 7, result, **kw)
	assert len(stored) == 6 and len(client.db['images']) == 3
	not_shown = other['judged']['images_not_shown']
	assert [i['kind'] for i in not_shown] == ['raw', 'deadwood_overlay', 'forest_cover_overlay']
	assert all(i['storage_path'] in stored and i['crop_id'] == 1 for i in not_shown)


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
	assert result.tiles_total == 4 and len(result.crops) == 4
	assert all(r.crop.in_aoi is None and len(r.answers) == 2 for r in result.crops)
	assert result.cost['haiku-5.5']['calls'] == 4 and result.cost['luna-medium']['cost_usd'] is None
	# an AOI limits the check to the tiles inside it
	inside = run_prediction_quality(42, ortho_file, _check_tiles(), _to_wgs(box(*_squares()[0])), predictions(), judges)
	assert inside.tiles_total == 1 and [r.tile.tile_id for r in inside.crops] == [1]
	# an AOI smaller than a tile is judged on the tile it touches, not left without crops
	corner = box(*_squares()[1]).centroid.buffer(5)
	small = run_prediction_quality(
		42, ortho_file, _check_tiles(), _to_wgs(corner), {'deadwood': [], 'forest': []}, judges
	)
	assert [r.tile.tile_id for r in small.crops] == [2]


def test_login_and_limit_errors_reach_the_worker_and_other_errors_stay_with_the_crop(ortho_file):
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
	failed = [r for r in result.crops if r.failures]
	assert len(failed) == 1 and 'boom' in failed[0].failures['b'] and len(failed[0].answers) == 1
	# the cuts are calibrated on both judges: a judge that answers no crop fails the run
	with pytest.raises(RuntimeError, match='b answered no crop: RuntimeError: boom'):
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


def test_the_handler_judges_the_preferred_predictions_and_stores_the_run(ortho_file, monkeypatch):
	from types import SimpleNamespace

	from processor.src.audit_worker import worker
	from processor.src.prediction_quality_v1 import handler

	monkeypatch.setattr(handler, 'local_cog', lambda *args: ortho_file)
	client, stored, refreshed = _FakeClient(_dataset()), {}, []
	judges = {
		'luna-medium': lambda prompt, images: _answer(dw_major=80, verdict='major'),
		'haiku-5.5': lambda prompt, images: _answer(dw_major=70, verdict='major'),
	}
	strict = {'crop_major_cut': {'deadwood': 52.0, 'forest': 5.0}, 'min_major_crops': 2}
	ctx = SimpleNamespace(
		run={'id': 5, 'dataset_id': 42},
		version={'config': {'rule_config': strict}},
		refresh=lambda: refreshed.append(not client.db.get('assessments')),
		client=client,
		judges=judges,
		token='t',
		put_image=lambda path, data, dataset_id: stored.__setitem__(path, (dataset_id, len(data))),
	)
	out = handler.handle(ctx)
	labels = {'deadwood': 11, 'forest_cover': 12}
	assert out['inputs'] == handler.inputs(client, 42) == {'ortho_sha256': SHA, 'aoi': None, 'label_ids': labels}
	assert out['coverage'] == {'mode': 'sampled', 'tiles_total': 4, 'crops': 4, 'exclude_set': 4, 'training_set': 4}
	assert out['cost']['luna-medium']['calls'] == 4
	assert len(client.db['crops']) == 4 and len(stored) == 12 and len(client.db['images']) == 12
	assert all(dataset_id == 42 for dataset_id, _ in stored.values())
	rows = client.db['assessments']
	assert len(rows) == 4 * 2 * 3 + 2 and {r['run_id'] for r in rows} == {5}
	rule_rows = {r['layer']: r for r in rows if r['assessor_kind'] == 'rule'}
	assert rule_rows['deadwood']['verdict'] == 'major' and rule_rows['deadwood']['details']['major_crops'] == 4
	# the registered version's cuts decide: a forest cut of 5 makes the judges' 10 major
	assert rule_rows['forest_cover']['verdict'] == 'major' and rule_rows['forest_cover']['label_id'] == 12
	assert out['evidence']['judged']['images_not_shown'] == [] and len(out['evidence']['judged']['crops']) == 4
	assert refreshed == [True], 'the login is renewed before the writes'
	# only the newest preferred prediction is drawn, without its deleted polygons
	covered = {c['pixel_x0']: c['selection']['exclude']['predicted']['deadwood'] for c in client.db['crops']}
	assert covered[0] == pytest.approx(1, abs=0.05) and covered[512] == covered[1024] == 0
	assert client.db['crops'][0]['geometry']['type'] == 'Polygon'
	assert 'updates' not in client.db, "the run row is the worker's to finish"
	assert worker.HANDLERS['prediction_quality'] == handler.__name__
	assert handler.CONFIG['models'].keys() == judges.keys()


def test_the_handler_waits_for_its_inputs(monkeypatch):
	from processor.src.prediction_quality_v1 import handler

	done = {'is_cog_done': True, 'is_embeddings_done': True, 'is_deadwood_done': True, 'is_forest_cover_done': True}
	assert handler.ready(done) and handler.ready({**done, 'is_deadwood_done': False, 'is_combined_model_done': True})
	assert not handler.ready({**done, 'is_embeddings_done': False})
	assert not handler.ready({**done, 'is_forest_cover_done': False})
	# a dataset without a prediction of the preferred model is left out of the queue (a ValueError)
	tables = _dataset()
	tables['v2_labels'] = [row for row in tables['v2_labels'] if row['id'] != 12]
	with pytest.raises(ValueError, match='no forest_cover prediction'):
		handler.inputs(_FakeClient(tables), 42)
	# a new AOI is a new run
	aoi = {'geometry': {'type': 'Polygon', 'coordinates': [[[0, 0], [1, 0], [1, 1], [0, 0]]]}, 'source': 'manual'}
	with_aoi = handler.inputs(_FakeClient(_dataset([{**aoi, 'dataset_id': 42}])), 42)
	assert with_aoi['aoi'] and with_aoi != handler.inputs(_FakeClient(_dataset()), 42)
