from contextlib import nullcontext

"""Dataset evaluation check: inputs from the COG, the band check, the model answer, the
dataset rule and its rule-only recomputation, and the worker handler (external models,
PostgREST and storage faked at their boundaries)."""

import io
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import rasterio
from PIL import Image, ImageDraw
from rasterio.transform import from_origin

from processor.src.audit_worker.models import LoginExpired
from processor.src.dataset_evaluation_v1 import check as check_module
from processor.src.dataset_evaluation_v1 import handler
from processor.src.dataset_evaluation_v1.bands import band_check
from processor.src.dataset_evaluation_v1.check import evaluate, payload as finish_payload
from processor.src.dataset_evaluation_v1.handler import tile_of
from processor.src.dataset_evaluation_v1.inputs import Tile, inside, padding, read_inputs
from processor.src.dataset_evaluation_v1.prompt import AnswerError, build_prompt, parse_answer
from processor.src.utils.stored_inputs import read_geometry

SHA = 'b' * 64
# EPSG:3857 metres near Freiburg (48.0 N): 0.05 m map pixels are about 3.3 cm on the ground
ORIGIN = (870000.0, 6110000.0)
MAP_PX = 0.05


def forest(h, w, seed=0):
	"""Green crowns on brown ground: a true colour forest scene."""
	rng = np.random.default_rng(seed)
	img = Image.new('RGB', (w, h), (110, 95, 70))
	draw = ImageDraw.Draw(img)
	for _ in range(max(4, h * w // 4000)):
		cx, cy, r = int(rng.integers(0, w)), int(rng.integers(0, h)), int(rng.integers(8, 30))
		colour = (50 + int(rng.integers(0, 30)), 110 + int(rng.integers(0, 40)), 45)
		draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=colour)
	return np.asarray(img).copy()


def write_cog(path: Path, rgb: np.ndarray, nodata_border: int = 0) -> Path:
	h, w = rgb.shape[:2]
	data = rgb.transpose(2, 0, 1).copy()
	if nodata_border:
		data[:, :nodata_border] = 0
	profile = dict(
		driver='GTiff',
		width=w,
		height=h,
		count=3,
		dtype='uint8',
		crs='EPSG:3857',
		transform=from_origin(*ORIGIN, MAP_PX, MAP_PX),
		tiled=True,
		blockxsize=256,
		blockysize=256,
		compress='deflate',
		nodata=0,
	)
	with rasterio.open(path, 'w', **profile) as dst:
		dst.write(data)
		dst.build_overviews([2, 4, 8], rasterio.enums.Resampling.average)
	return path


@pytest.fixture
def cog(tmp_path):
	return write_cog(tmp_path / 'forest_cog.tif', forest(3000, 4000), nodata_border=200)


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------


@pytest.mark.unit
def test_inputs_read_a_bounded_overview_and_four_native_crops_spread_over_the_data(cog):
	inputs = read_inputs(str(cog), seed=7, overview_px=1024, crop_px=512)

	assert inputs.overview.shape == (768, 1024, 3)
	assert 0.90 < inputs.valid.mean() < 0.96  # the 200 px no-data border
	assert inputs.native_mpp == pytest.approx(MAP_PX * np.cos(np.radians(48.06)), rel=0.02)
	assert len(inputs.crops) == 4
	for crop in inputs.crops:
		col, row, w, h = crop.cog_window
		assert crop.image.shape == (512, 512, 3) and (w, h) == (512, 512)
	cols = sorted(c.cog_window[0] for c in inputs.crops)
	assert cols[0] < 1500 and cols[-1] > 2000  # spread over the whole image, not one part of it


@pytest.mark.unit
def test_crops_are_the_same_on_a_rerun_and_move_with_the_seed(cog):
	first = [c.cog_window for c in read_inputs(str(cog), seed=11, overview_px=512, crop_px=256).crops]
	again = [c.cog_window for c in read_inputs(str(cog), seed=11, overview_px=512, crop_px=256).crops]
	other = [c.cog_window for c in read_inputs(str(cog), seed=12, overview_px=512, crop_px=256).crops]

	assert first == again
	assert first != other


@pytest.mark.unit
def test_a_small_ortho_gives_crops_of_its_own_size(tmp_path):
	small = write_cog(tmp_path / 'small.tif', forest(300, 400))
	inputs = read_inputs(str(small), overview_px=2048, crop_px=1024)

	assert inputs.overview.shape == (300, 400, 3)
	assert all(c.image.shape == (300, 400, 3) for c in inputs.crops)


@pytest.mark.unit
def test_white_padding_without_a_mask_is_no_data_but_white_inside_the_data_is_kept():
	rgb = forest(200, 300)
	rgb[:, :60] = 255  # footprint padding along the left edge
	rgb[90:110, 140:160] = 255  # a white roof inside the data
	valid = np.ones(rgb.shape[:2], bool)
	pad = padding(rgb, valid)

	assert pad[:, :60].all()
	assert not pad[90:110, 140:160].any()
	assert pad.sum() == 200 * 60


@pytest.mark.unit
def test_crop_centres_keep_the_whole_crop_inside_the_data():
	mask = np.zeros((20, 20), bool)
	mask[2:12, 3:15] = True
	ok = inside(mask, 2)

	assert ok[4:10, 5:13].all() and ok.sum() == 6 * 8
	assert inside(mask, 0) is mask
	assert not inside(np.ones((3, 3), bool), 2).any()


@pytest.mark.unit
def test_crops_on_padded_orthos_stay_off_the_padding(tmp_path):
	rgb = forest(1200, 1600)
	rgb[:, :500] = 255  # white padding, no mask
	padded = tmp_path / 'padded.tif'
	h, w = rgb.shape[:2]
	with rasterio.open(
		padded,
		'w',
		driver='GTiff',
		width=w,
		height=h,
		count=3,
		dtype='uint8',
		crs='EPSG:3857',
		transform=from_origin(*ORIGIN, MAP_PX, MAP_PX),
		tiled=True,
	) as dst:
		dst.write(rgb.transpose(2, 0, 1))
	inputs = read_inputs(str(padded), overview_px=400, crop_px=256)

	assert inputs.valid[:, :120].sum() == 0
	assert all(c.cog_window[0] >= 500 for c in inputs.crops)
	assert all((c.image < 250).any(axis=2).mean() > 0.95 for c in inputs.crops)


def clip_tiles(cog_path):
	"""CLIP tiles over the COG: 51.2 m squares on a 10 cm UTM 32N grid, as the embedding stage makes."""
	from pyproj import Transformer

	with rasterio.open(cog_path) as src:
		left, bottom, right, top = src.bounds
	to_utm = Transformer.from_crs(3857, 32632, always_xy=True)
	to_wgs = Transformer.from_crs(32632, 4326, always_xy=True)
	x_min, y_max = to_utm.transform(left, top)
	x_max, y_min = to_utm.transform(right, bottom)
	tiles = []
	for j, y in enumerate(np.arange(y_max - 51.2, y_min, -51.2)):
		for i, x in enumerate(np.arange(x_min, x_max - 51.2, 51.2)):
			tiles.append(Tile((i * 512, j * 512, (i + 1) * 512, (j + 1) * 512), to_wgs.transform(x + 25.6, y + 25.6)))
	return tiles


@pytest.mark.unit
def test_crops_are_spread_clip_tiles_rendered_at_5_cm(tmp_path):

	big = tmp_path / 'big.tif'
	rgb = forest(4500, 6000)
	with rasterio.open(
		big,
		'w',
		driver='GTiff',
		width=6000,
		height=4500,
		count=3,
		dtype='uint8',
		crs='EPSG:3857',
		transform=from_origin(*ORIGIN, 0.07, 0.07),
		tiled=True,
		compress='deflate',
	) as dst:
		dst.write(rgb.transpose(2, 0, 1))
		dst.build_overviews([2, 4, 8], rasterio.enums.Resampling.average)
	tiles = clip_tiles(big)
	inputs = read_inputs(str(big), seed=4, overview_px=1024, tiles=tiles)

	assert len(tiles) >= 16 and len(inputs.crops) == 4
	assert inputs.settings['crop_picker'] == 'clip-grid-kmeans-v1'
	by_window = {t.window: t for t in tiles}
	for crop in inputs.crops:
		assert crop.grid_window in by_window and crop.cog_window is None
		assert crop.image.shape == (1024, 1024, 3) and crop.mpp == 0.05
		centre = crop.footprint.centroid
		assert centre.x == pytest.approx(by_window[crop.grid_window].centre[0], abs=1e-6)
	assert len({c.grid_window for c in inputs.crops}) == 4
	again = read_inputs(str(big), seed=4, overview_px=1024, tiles=tiles)
	assert [c.grid_window for c in again.crops] == [c.grid_window for c in inputs.crops]


@pytest.mark.unit
def test_tiles_off_the_data_fall_back_to_native_windows(cog):
	far = [Tile((0, 0, 512, 512), (10.0, 50.0))]
	inputs = read_inputs(str(cog), overview_px=512, crop_px=256, tiles=far)

	assert inputs.settings['crop_picker'] == 'kmeans-inside-v1'
	assert all(c.grid_window is None and c.cog_window for c in inputs.crops)


@pytest.mark.unit
def test_a_tile_row_reads_as_geojson_or_ewkb():
	from shapely.geometry import box as shapely_box

	square = shapely_box(7.80, 48.00, 7.81, 48.01)
	row = {'pixel_x0': 0, 'pixel_y0': 512, 'pixel_x1': 512, 'pixel_y1': 1024}
	for geometry in ({'type': 'Polygon', 'coordinates': [list(square.exterior.coords)]}, square.wkb_hex):
		tile = tile_of({**row, 'geometry': read_geometry(geometry)})
		assert tile.window == (0, 512, 512, 1024)
		assert tile.centre == pytest.approx((7.805, 48.005))


# ---------------------------------------------------------------------------
# Band check
# ---------------------------------------------------------------------------

RGB_PROFILE = {'Bands': 4, 'Dtype': 'uint8', 'ColorInterp': ['red', 'green', 'blue', 'alpha']}
BAND_MAJOR_AT = handler.RULES_CONFIG['band_major_at']


def bands_of(rgb):
	return rgb.transpose(2, 0, 1), rgb.any(axis=2)


@pytest.mark.unit
def test_true_colour_forest_passes_the_band_check():
	band = band_check(RGB_PROFILE, *bands_of(forest(400, 400)))

	assert band['likelihood'] == 0 and band['findings'] == []
	assert len(band['bands']) == 3


@pytest.mark.unit
def test_near_infrared_in_the_red_band_is_flagged():
	# Healthy vegetation is bright in near-infrared: a NIR-R-G image looks red, like dataset 6036
	img = forest(400, 400)
	false_colour = np.stack([np.clip(img[..., 1].astype(int) + 60, 0, 255), img[..., 0], img[..., 2]], -1).astype(
		np.uint8
	)
	band = band_check(RGB_PROFILE, *bands_of(false_colour))

	assert band['findings'][0]['code'] == 'false_colour_red'
	assert band['likelihood'] >= 50


@pytest.mark.unit
def test_gray_or_single_band_imagery_is_not_rgb():
	gray = np.repeat(forest(300, 300)[..., 1:2], 3, axis=2)
	assert band_check(RGB_PROFILE, *bands_of(gray))['likelihood'] >= BAND_MAJOR_AT

	single = band_check({'Bands': 1, 'Dtype': 'float32', 'ColorInterp': ['gray']}, *bands_of(forest(300, 300)))
	assert single['likelihood'] >= BAND_MAJOR_AT
	assert single['findings'][0]['code'] == 'single_band'


@pytest.mark.unit
def test_a_multispectral_upload_alone_is_only_noted():
	profile = {'Bands': 10, 'Dtype': 'float32', 'ColorInterp': ['gray'] + ['undefined'] * 9}
	band = band_check(profile, *bands_of(forest(300, 300)))

	assert band['likelihood'] == 40
	assert band['findings'][0]['code'] == 'multispectral_source'


# ---------------------------------------------------------------------------
# Model answer
# ---------------------------------------------------------------------------


def answer(verdict='keep', likelihood=5, reason='none', **flags):
	return json.dumps(
		{
			'verdict': verdict,
			'exclude_likelihood': likelihood,
			'reason': reason,
			'flags': {
				'blurry': 0,
				'not_rgb': 0,
				'no_trees': 0,
				'broken_ortho': 0,
				'too_dark': 0,
				'artifacts': 0,
				'cog_issue': 0,
				'thumbnail_issue': 0,
				'reprocess': 0,
				**flags,
			},
			'sharpness': 'sharp',
			'lighting': 'good',
			'leaf_state': 'leaf_on',
			'image_type': 'rgb',
			'scene': 'forest_interior',
			'land_cover': 'closed_forest',
			'summary': 'Closed conifer forest, sharp.',
		}
	)


@pytest.mark.unit
def test_a_reply_becomes_a_dataset_judgement_in_the_audit_vocabulary():
	j = parse_answer('Here it is:\n```json\n' + answer('exclude', 88, 'blurry', blurry=90) + '\n```', 'haiku-5.5')

	assert j.judge == 'haiku-5.5' and j.verdict == 'major' and j.likelihood == 88
	assert j.exclude_reason == 'blurry' and j.summary == 'Closed conifer forest, sharp.'
	assert j.raw['flags']['blurry'] == 90.0 and j.raw['scene'] == 'forest_interior'
	assert set(j.row()) == {
		'judge', 'verdict', 'likelihood', 'cog_issue', 'thumbnail_issue', 'exclude_reason', 'summary', 'raw'
	}, 'only columns audit.dataset_vlm_judgements has'


@pytest.mark.unit
def test_a_model_that_cannot_tell_is_not_assessable_and_issues_count_from_fifty():
	assert parse_answer(answer('unsure', 50), 'haiku-5.5').verdict == 'not_assessable'
	assert parse_answer(answer('fix', 10), 'haiku-5.5').verdict == 'minor'
	j = parse_answer(answer('fix', 10, cog_issue=49, thumbnail_issue=50), 'haiku-5.5')
	assert (j.cog_issue, j.thumbnail_issue) == (False, True)
	assert parse_answer(answer('keep'), 'haiku-5.5').exclude_reason is None


@pytest.mark.unit
def test_a_category_outside_the_fixed_list_is_dropped_but_a_bad_verdict_fails():
	value = json.loads(answer())
	value['scene'] = 'a sunny forest'
	assert parse_answer(json.dumps(value), 'luna-medium').raw['scene'] is None

	with pytest.raises(AnswerError):
		parse_answer(answer().replace('"keep"', '"delete"'), 'luna-medium')
	with pytest.raises(AnswerError):
		parse_answer(answer(likelihood=140), 'luna-medium')
	with pytest.raises(AnswerError):
		parse_answer('I cannot see the images.', 'luna-medium')


# ---------------------------------------------------------------------------
# One run end to end with fake models
# ---------------------------------------------------------------------------


class Fake:
	"""A judge as the audit worker hands it over: (prompt, PIL images) -> answer text."""

	def __init__(self, *replies):
		self.replies, self.prompts, self.images = list(replies), [], []

	def __call__(self, prompt, images):
		self.prompts.append(prompt)
		self.images.append(images)
		reply = self.replies.pop(0)
		if isinstance(reply, Exception):
			raise reply
		return reply


def thumbnail_bytes():
	out = io.BytesIO()
	Image.fromarray(forest(256, 256)).save(out, 'JPEG')
	return out.getvalue()


@pytest.mark.unit
def test_a_run_judges_six_images_and_stores_every_answer(cog):
	inputs = read_inputs(str(cog), seed=3, overview_px=1024, crop_px=512)
	luna = Fake(answer('fix', 10, reprocess=55, thumbnail_issue=60))
	haiku = Fake(answer('fix', 20, reprocess=60, thumbnail_issue=55))
	evaluation = evaluate(
		inputs,
		{'luna-medium': luna, 'haiku-5.5': haiku},
		source_profile=RGB_PROFILE,
		thumbnail=thumbnail_bytes(),
	)

	assert len(luna.images[0]) == 6 and all(isinstance(i, Image.Image) for i in luna.images[0])
	assert luna.images[0][0].size == (1024, 768)
	assert 'Judge the whole orthophoto' in luna.prompts[0] and 'Image 6 is the 256 px thumbnail' in luna.prompts[0]
	# every model's judgement is stored; the band check is run evidence, the verdict the database's
	assert [j.judge for j in evaluation.judgements] == ['luna-medium', 'haiku-5.5']
	assert [(j.verdict, j.thumbnail_issue) for j in evaluation.judgements] == [('minor', True), ('minor', True)]
	assert evaluation.evidence['band_check']['likelihood'] == 0 and evaluation.evidence['empty'] is False
	assert 'phash' not in evaluation.evidence
	assert evaluation.judgements[1].raw['attempt'] == 1 and evaluation.cost['haiku-5.5']['cost_usd'] is None
	assert evaluation.evidence['settings'] == inputs.settings  # the tile settings are evidence

	judged = {'ortho_sha256': SHA}
	result = finish_payload(evaluation, inputs, 42, 7, judged)
	assert set(result) == {'inputs', 'evidence', 'tiles', 'images', 'dataset_judgements', 'tile_judgements'}
	assert result['inputs'] == judged and result['tile_judgements'] == []
	assert [i['kind'] for i in result['images']] == ['overview', 'raw', 'raw', 'raw', 'raw', 'thumbnail']
	assert [i['tile_index'] for i in result['images']] == [None, 1, 2, 3, 4, None]
	# one folder per run: the ortho hash is in the run's inputs only
	assert result['images'][0]['storage_path'] == 'audit/dataset_evaluation/42/run-7/overview.jpg'
	assert result['images'][1]['storage_path'] == 'audit/dataset_evaluation/42/run-7/tile-1.jpg'
	assert result['images'][0]['sha256'] == evaluation.images[0].sha256
	assert len({i['storage_path'] for i in result['images']}) == 6
	assert [j['judge'] for j in result['dataset_judgements']] == ['luna-medium', 'haiku-5.5']
	assert len(result['tiles']) == 4 and result['tiles'][0]['pixel_window'] is None
	assert set(result['tiles'][0]) == {'pixel_window', 'geometry', 'mpp', 'size_px'}
	assert result['evidence']['tiles'][0]['picker'] == 'kmeans-inside-v1'
	assert result['evidence']['coverage'] == {'tiles': 4, 'tile_picker': 'kmeans-inside-v1'}
	assert not any(SHA in json.dumps(row) for row in result['tiles'] + result['images'])
	json.dumps(result)  # the RPC argument must serialise


@pytest.mark.unit
def test_the_overview_is_the_orthophoto_alone_with_no_data_hidden(cog):
	inputs = read_inputs(str(cog), overview_px=1024, crop_px=256)
	shown = check_module.overview_image(inputs)

	assert (shown[~inputs.valid] == 0).all()
	# nothing is drawn on it: the area of interest is a check of its own
	assert (shown[inputs.valid] == inputs.overview[inputs.valid]).all()


@pytest.mark.unit
def test_a_malformed_reply_is_asked_again_once_and_login_errors_reach_the_worker(cog):
	inputs = read_inputs(str(cog), overview_px=512, crop_px=256)
	common = dict(source_profile=RGB_PROFILE)

	luna = Fake('not json', answer())
	evaluation = evaluate(inputs, {'luna-medium': luna, 'haiku-5.5': Fake(answer())}, **common)
	assert [j.verdict for j in evaluation.judgements] == ['ok', 'ok']
	assert len(luna.prompts) == 2 and evaluation.judgements[0].raw['attempt'] == 2

	with pytest.raises(AnswerError):
		evaluate(inputs, {'luna-medium': Fake('no', 'still no'), 'haiku-5.5': Fake(answer())}, **common)
	with pytest.raises(LoginExpired):
		evaluate(
			inputs,
			{'luna-medium': Fake(answer()), 'haiku-5.5': Fake(LoginExpired('claude', 'Please run /login'))},
			**common,
		)


@pytest.mark.unit
def test_the_prompt_lists_only_the_reasons_the_models_decide():
	prompt = build_prompt(0.4, 0.03, has_thumbnail=False)

	assert 'about 40 cm per pixel' in prompt and 'about 3.0 cm per pixel' in prompt
	assert 'Images 2 to 5 are 4 samples' in prompt
	assert 'Image 6' not in prompt and 'Judge the whole orthophoto' in prompt
	assert 'area of interest' not in prompt and 'AOI' not in prompt
	assert '"reason": "blurry | no_trees | artifacts | not_rgb | broken_ortho | too_dark | other | none"' in prompt


# ---------------------------------------------------------------------------
# The worker handler, with PostgREST, storage and the judges faked at their boundaries
# ---------------------------------------------------------------------------


class Rows:
	"""Enough of a PostgREST table: select / eq / is_ / order / range / execute, and insert."""

	def __init__(self, rows):
		self.rows, self.filters, self.span = rows, [], None

	def select(self, *_):
		return Rows(self.rows)

	def eq(self, key, value):
		self.filters.append((key, value))
		return self

	def is_(self, key, value):
		self.filters.append((key, None if value == 'null' else value))
		return self

	def insert(self, row):
		self.rows.append(row)
		return SimpleNamespace(execute=lambda: SimpleNamespace(data=[row]))

	def order(self, *_):
		return self

	def range(self, start, end):
		self.span = (start, end)
		return self

	def execute(self):
		rows = [r for r in self.rows if all(r.get(k) == v for k, v in self.filters)]
		if self.span:
			rows = rows[self.span[0] : self.span[1] + 1]
		return SimpleNamespace(data=rows)


class FakeClient:
	def __init__(self, tables):
		self.tables, self.calls = tables, []

	def table(self, name):
		return Rows(self.tables.setdefault(name, []))

	def schema(self, name):
		assert name == 'audit'
		return self

	def rpc(self, name, args):
		self.calls.append((name, args))
		return SimpleNamespace(execute=lambda: SimpleNamespace(data=None))


@pytest.mark.unit
def test_the_handler_uploads_the_images_and_returns_the_rows_to_store(cog, tmp_path, monkeypatch):
	monkeypatch.setattr(handler, 'readable_cog', lambda *args: nullcontext(str(cog)))
	monkeypatch.setattr(
		handler, 'pull_file_from_storage_server', lambda remote, local, *a: Path(local).write_bytes(thumbnail_bytes())
	)
	client = FakeClient(
		{
			'v2_cogs': [
				{'dataset_id': 42, 'cog_file_size': 1, 'cog_file_name': 'c.tif', 'cog_path': 'u/c.tif', 'version': 1}
			],
			'v2_orthos': [
				{
					'dataset_id': 42,
					'ortho_file_name': 'o.tif',
					'version': 1,
					'ortho_file_size': 1,
					'sha256': SHA,
					'ortho_info': {'Profile': RGB_PROFILE},
				}
			],
			'v2_thumbnails': [{'dataset_id': 42, 'thumbnail_path': 'u/t.jpg'}],
			'v2_aois': [],
			'v2_tile_embeddings': [],
		}
	)
	uploaded, refreshed = [], []
	ctx = SimpleNamespace(
		run={'id': 7, 'dataset_id': 42},
		version={'version': 'v3', 'config': {}},
		client=client,
		token='t',
		judges={
			'luna-medium': Fake(answer('exclude', 90, 'blurry')),
			'haiku-5.5': Fake(answer('exclude', 80, 'blurry')),
		},
		refresh=lambda: refreshed.append(len(uploaded)),
		put_image=lambda path, data, dataset_id: uploaded.append(path),
	)
	result = handler.handle(ctx)

	# the handler uploads the files and returns the rows: storing them is the worker's finish_run
	assert client.calls == [] and refreshed == [0], 'the login is renewed before the uploads'
	assert uploaded == [i['storage_path'] for i in result['images']]
	assert uploaded[0] == 'audit/dataset_evaluation/42/run-7/overview.jpg' and uploaded[5].endswith('/thumbnail.jpg')
	assert [(j['judge'], j['verdict'], j['exclude_reason']) for j in result['dataset_judgements']] == [
		('luna-medium', 'major', 'blurry'),
		('haiku-5.5', 'major', 'blurry'),
	]
	assert 'phash' not in result['evidence'] and result['evidence']['band_check']['likelihood'] == 0
	assert result['evidence']['coverage'] == {'tiles': 4, 'tile_picker': 'kmeans-inside-v1'}
	# the run's inputs have the one shape the queueing compares
	assert result['inputs'] == handler.inputs(client, 42) == {'ortho_sha256': SHA}


@pytest.mark.unit
@pytest.mark.parametrize('earlier', ['v1', 'v2'])
def test_a_run_of_an_earlier_version_is_not_judged_by_this_code(earlier):
	"""Version 1 judged inside the AOI and version 2 had the duplicate check: their runs must not
	get this code's answers under their name."""
	ctx = SimpleNamespace(run={'id': 7, 'dataset_id': 42}, version={'version': earlier, 'config': {}}, client=None, token='t')
	with pytest.raises(ValueError, match=f'the run is of version {earlier}; this code judges v3'):
		handler.handle(ctx)


@pytest.mark.unit
def test_the_handler_runs_after_the_cog_thumbnail_and_tiles_and_is_registered():
	from processor.src.audit_worker import worker

	assert worker.HANDLERS['dataset_evaluation'] == 'processor.src.dataset_evaluation_v1.handler'
	handlers, missing = worker.load_handlers()
	evaluation = handlers['dataset_evaluation']
	assert not missing and evaluation.VERSION == 'v3' and not hasattr(evaluation, 'recompute')
	# what is asked is the version; how the answers turn into keep or exclude, its rules
	assert (evaluation.RULES, evaluation.RULES_CONFIG) == ('rules-v1', {'decider': 'haiku', 'band_major_at': 90})
	assert not {'duplicates', 'phash', 'rules', 'rule_config'} & set(evaluation.CONFIG)
	assert set(handlers['dataset_evaluation'].CONFIG['models']) == {'luna-medium', 'haiku-5.5'}
	assert handler.ready({'is_cog_done': True, 'is_thumbnail_done': True, 'is_embeddings_done': True})
	assert not handler.ready({'is_cog_done': True, 'is_thumbnail_done': True, 'is_embeddings_done': False})


# ---------------------------------------------------------------------------
# Empty COG
# ---------------------------------------------------------------------------


def never(prompt, images):
	raise AssertionError('no model may be asked about an empty COG')


@pytest.mark.unit
@pytest.mark.parametrize('kept', [0, 6])
def test_a_cog_without_a_usable_image_is_judged_by_no_model(tmp_path, kept):
	rgb = np.zeros((1200, 1600, 3), np.uint8)
	rgb[:kept, :kept] = forest(max(kept, 1), max(kept, 1))[:kept, :kept]  # a few stray pixels at most
	empty = write_cog(tmp_path / 'empty.tif', rgb)
	inputs = read_inputs(str(empty), overview_px=512, tiles=[Tile((0, 0, 512, 512), (7.8157, 48.0185))])

	assert inputs.empty and inputs.crops == [] and inputs.settings['crop_picker'] is None
	evaluation = evaluate(
		inputs,
		{'luna-medium': never, 'haiku-5.5': never},
		source_profile=RGB_PROFILE,
		thumbnail=thumbnail_bytes(),
	)
	# the rules exclude it as a broken ortho from the evidence
	assert evaluation.judgements == [] and evaluation.evidence['empty'] is True
	assert 'band_check' not in evaluation.evidence
	result = finish_payload(evaluation, inputs, 3327, 8, {'ortho_sha256': SHA})
	assert result['tiles'] == [] and result['dataset_judgements'] == []
	assert [i['kind'] for i in result['images']] == ['overview', 'thumbnail']
	json.dumps(result)


@pytest.mark.unit
def test_the_handler_finishes_an_empty_cog_without_a_model_call(tmp_path, monkeypatch):
	empty = write_cog(tmp_path / 'empty.tif', np.zeros((800, 800, 3), np.uint8))
	monkeypatch.setattr(handler, 'readable_cog', lambda *args: nullcontext(str(empty)))
	client = FakeClient(
		{
			'v2_cogs': [
				{'dataset_id': 42, 'cog_file_size': 1, 'cog_file_name': 'c.tif', 'cog_path': 'u/c.tif', 'version': 1}
			],
			'v2_orthos': [
				{'dataset_id': 42, 'ortho_file_name': 'o.tif', 'version': 1, 'ortho_file_size': 1, 'sha256': SHA}
			],
		}
	)
	uploaded = []
	ctx = SimpleNamespace(
		run={'id': 8, 'dataset_id': 42},
		client=client,
		token='t',
		judges={'luna-medium': never, 'haiku-5.5': never},
		refresh=lambda: None,
		put_image=lambda path, data, dataset_id: uploaded.append(path),
	)
	result = handler.handle(ctx)

	assert uploaded == ['audit/dataset_evaluation/42/run-8/overview.jpg']
	assert result['evidence']['empty'] is True and result['dataset_judgements'] == []
	assert result['evidence']['coverage'] == {'tiles': 0, 'tile_picker': None} and result['evidence']['cost'] == {}


@pytest.mark.unit
@pytest.mark.parametrize(
	('crops', 'samples', 'thumbnail'),
	[
		(0, 'no full resolution samples', 'Image 2 is'),
		(1, 'Image 2 is one sample', 'Image 3 is'),
		(2, 'Images 2 to 3 are 2 samples', 'Image 4 is'),
	],
)
def test_the_prompt_numbers_the_images_that_are_sent(crops, samples, thumbnail):
	prompt = build_prompt(0.4, 0.03, has_thumbnail=True, crop_count=crops)

	assert samples in prompt and f'{thumbnail} the 256 px thumbnail' in prompt
	assert 'Images 2 to 5' not in prompt


@pytest.mark.unit
@pytest.mark.parametrize(
	'reply',
	[
		'[1, 2]',
		'{"verdict": ["keep"], "exclude_likelihood": 5}',
		'{"verdict": "keep", "exclude_likelihood": 5, "flags": "none"}',
		'{"verdict": "keep", "exclude_likelihood": 5, "flags": [1]}',
		'{"verdict": "keep", "exclude_likelihood": null}',
	],
)
def test_a_reply_of_the_wrong_shape_is_asked_again_not_failed(reply):
	with pytest.raises(AnswerError):
		parse_answer(reply, 'haiku-5.5')


@pytest.mark.unit
def test_a_colour_ratio_guess_stays_below_the_rules_threshold():
	"""Red soil or autumn foliage is red too: the ratio is noted, the models decide."""
	red = np.zeros((3, 64, 64), np.uint8)
	red[0], red[1], red[2] = 220, 90, 80
	red[:, ::2, ::2] += 9  # not three identical bands
	band = band_check(RGB_PROFILE, red, np.ones((64, 64), bool))

	assert band['findings'][0]['code'] == 'false_colour_red'
	assert band['likelihood'] == 85 < BAND_MAJOR_AT
