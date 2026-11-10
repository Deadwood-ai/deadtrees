"""Dataset evaluation check v1: inputs from the COG, band and duplicate rules, the model
answer, the dataset rule and the model transports (external models faked at their
process and HTTP boundaries)."""

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
from processor.src.dataset_evaluation_v1.check import evaluate, store_payload
from processor.src.dataset_evaluation_v1.handler import aoi_key, tile_of
from processor.src.dataset_evaluation_v1.inputs import Tile, inside, padding, read_inputs
from processor.src.dataset_evaluation_v1.prompt import AnswerError, build_prompt, parse_answer
from processor.src.dataset_evaluation_v1.rules import (
	Call,
	band_check,
	dataset_rule,
	duplicate_check,
	hamming,
	phash,
)

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


def aoi_box(x0, y0, x1, y1):
	"""An AOI over COG pixel columns x0..x1 and rows y0..y1, in EPSG:4326 GeoJSON."""
	from pyproj import Transformer

	t = Transformer.from_crs(3857, 4326, always_xy=True)
	corners = [(ORIGIN[0] + x * MAP_PX, ORIGIN[1] - y * MAP_PX) for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
	ring = [list(t.transform(*c)) for c in corners]
	return {'type': 'Polygon', 'coordinates': [ring + [ring[0]]]}


@pytest.fixture
def cog(tmp_path):
	return write_cog(tmp_path / 'forest_cog.tif', forest(3000, 4000), nodata_border=200)


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------


@pytest.mark.unit
def test_inputs_read_a_bounded_overview_and_four_native_crops_inside_the_aoi(cog):
	aoi = aoi_box(2000, 0, 4000, 3000)
	inputs = read_inputs(str(cog), aoi, seed=7, overview_px=1024, crop_px=512)

	assert inputs.overview.shape == (768, 1024, 3)
	assert 0.90 < inputs.valid.mean() < 0.96  # the 200 px no-data border
	assert inputs.aoi is not None and 0.45 < inputs.aoi.mean() < 0.55
	assert inputs.native_mpp == pytest.approx(MAP_PX * np.cos(np.radians(48.06)), rel=0.02)
	assert len(inputs.crops) == 4
	for crop in inputs.crops:
		col, row, w, h = crop.cog_window
		assert crop.image.shape == (512, 512, 3) and (w, h) == (512, 512)
		assert col + w / 2 >= 1900  # centred in the AOI half
	cols = sorted(c.cog_window[0] for c in inputs.crops)
	assert cols[-1] - cols[0] > 600  # spread out, not clustered


@pytest.mark.unit
def test_crops_are_the_same_on_a_rerun_and_move_with_the_seed(cog):
	first = [c.cog_window for c in read_inputs(str(cog), seed=11, overview_px=512, crop_px=256).crops]
	again = [c.cog_window for c in read_inputs(str(cog), seed=11, overview_px=512, crop_px=256).crops]
	other = [c.cog_window for c in read_inputs(str(cog), seed=12, overview_px=512, crop_px=256).crops]

	assert first == again
	assert first != other


@pytest.mark.unit
def test_an_aoi_off_the_data_is_ignored(cog):
	inputs = read_inputs(str(cog), aoi_box(5000, 5000, 6000, 6000), overview_px=512, crop_px=256)

	assert inputs.aoi is None and len(inputs.crops) == 4


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
	from shapely.geometry import shape as to_shape

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
	# the east half, in this COG's 0.07 m pixels
	aoi = aoi_box(3000 * 0.07 / MAP_PX, 0, 6000 * 0.07 / MAP_PX, 4500 * 0.07 / MAP_PX)
	inputs = read_inputs(str(big), aoi, seed=4, overview_px=1024, tiles=tiles)

	assert len(tiles) >= 16 and len(inputs.crops) == 4
	assert inputs.settings['crop_picker'] == 'clip-grid-kmeans-v1'
	by_window = {t.window: t for t in tiles}
	for crop in inputs.crops:
		assert crop.grid_window in by_window and crop.cog_window is None
		assert crop.image.shape == (1024, 1024, 3) and crop.mpp == 0.05
		centre = crop.footprint.centroid
		assert centre.x == pytest.approx(by_window[crop.grid_window].centre[0], abs=1e-6)
		assert to_shape(aoi).contains(centre)
	assert len({c.grid_window for c in inputs.crops}) == 4
	again = read_inputs(str(big), aoi, seed=4, overview_px=1024, tiles=tiles)
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
		tile = tile_of({**row, 'geometry': geometry})
		assert tile.window == (0, 512, 512, 1024)
		assert tile.centre == pytest.approx((7.805, 48.005))


# ---------------------------------------------------------------------------
# Band check
# ---------------------------------------------------------------------------

RGB_PROFILE = {'Bands': 4, 'Dtype': 'uint8', 'ColorInterp': ['red', 'green', 'blue', 'alpha']}


def bands_of(rgb):
	return rgb.transpose(2, 0, 1), rgb.any(axis=2)


@pytest.mark.unit
def test_true_colour_forest_passes_the_band_check():
	call = band_check(RGB_PROFILE, *bands_of(forest(400, 400)))

	assert call.verdict == 'ok' and call.major_likelihood == 0
	assert call.model == 'band_check' and call.prompt_version == 'v1'
	assert len(call.details['bands']) == 3


@pytest.mark.unit
def test_near_infrared_in_the_red_band_goes_to_a_person():
	# Healthy vegetation is bright in near-infrared: a NIR-R-G image looks red, like dataset 6036
	img = forest(400, 400)
	false_colour = np.stack([np.clip(img[..., 1].astype(int) + 60, 0, 255), img[..., 0], img[..., 2]], -1).astype(
		np.uint8
	)
	call = band_check(RGB_PROFILE, *bands_of(false_colour))

	assert call.verdict in ('unsure', 'major')
	assert call.details['findings'][0]['code'] == 'false_colour_red'
	assert call.modes['not_rgb']['likelihood'] >= 50


@pytest.mark.unit
def test_gray_or_single_band_imagery_is_not_rgb():
	gray = np.repeat(forest(300, 300)[..., 1:2], 3, axis=2)
	assert band_check(RGB_PROFILE, *bands_of(gray)).verdict == 'major'

	single = band_check({'Bands': 1, 'Dtype': 'float32', 'ColorInterp': ['gray']}, *bands_of(forest(300, 300)))
	assert single.verdict == 'major'
	assert single.details['findings'][0]['code'] == 'single_band'


@pytest.mark.unit
def test_a_multispectral_upload_alone_is_only_noted():
	profile = {'Bands': 10, 'Dtype': 'float32', 'ColorInterp': ['gray'] + ['undefined'] * 9}
	call = band_check(profile, *bands_of(forest(300, 300)))

	assert call.verdict == 'ok' and call.major_likelihood == 40
	assert call.details['findings'][0]['code'] == 'multispectral_source'


# ---------------------------------------------------------------------------
# Duplicates
# ---------------------------------------------------------------------------


def jpeg_roundtrip(rgb, quality=70):
	out = io.BytesIO()
	Image.fromarray(rgb).save(out, 'JPEG', quality=quality)
	return np.asarray(Image.open(out))


@pytest.mark.unit
def test_the_perceptual_hash_survives_a_re_export_and_separates_other_scenes():
	a = forest(600, 800, seed=1)
	valid = np.ones(a.shape[:2], bool)
	same = phash(a, valid)

	assert -(1 << 63) <= same < (1 << 63)
	assert phash(a, valid) == same
	assert hamming(same, phash(jpeg_roundtrip(a), valid)) <= 6
	assert hamming(same, phash(forest(600, 800, seed=2), valid)) > 12


@pytest.mark.unit
def test_duplicate_matches_flag_and_never_exclude():
	assert duplicate_check([]).verdict == 'ok'

	call = duplicate_check(
		[
			{'dataset_id': 9, 'kind': 'same_flight_day', 'hamming': 30, 'overlap': 0.98},
			{'dataset_id': 4, 'kind': 'same_file', 'hamming': 0, 'overlap': 1.0},
		]
	)
	assert call.verdict == 'unsure'
	assert call.major_likelihood == 95
	assert [c['dataset_id'] for c in call.details['candidates']] == [4, 9]


# ---------------------------------------------------------------------------
# Model answer and dataset rule
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
def test_a_reply_becomes_a_model_assessment_in_the_audit_vocabulary():
	call = parse_answer('Here it is:\n```json\n' + answer('exclude', 88, 'blurry', blurry=90) + '\n```', 'haiku-5.5')

	assert (call.assessor_kind, call.model, call.prompt_version) == ('model', 'haiku-5.5', 'v1')
	assert call.verdict == 'major' and call.major_likelihood == 88
	assert call.modes['blurry'] == {'likelihood': 90.0}
	assert call.details['reason'] == 'blurry' and call.details['scene'] == 'forest_interior'


@pytest.mark.unit
def test_a_category_outside_the_fixed_list_is_dropped_but_a_bad_verdict_fails():
	value = json.loads(answer())
	value['scene'] = 'a sunny forest'
	assert parse_answer(json.dumps(value), 'luna-medium').details['scene'] is None

	with pytest.raises(AnswerError):
		parse_answer(answer().replace('"keep"', '"delete"'), 'luna-medium')
	with pytest.raises(AnswerError):
		parse_answer(answer(likelihood=140), 'luna-medium')
	with pytest.raises(AnswerError):
		parse_answer('I cannot see the images.', 'luna-medium')


def calls(*replies):
	return [parse_answer(r, m) for r, m in zip(replies, ('luna-medium', 'haiku-5.5'))]


OK_BAND = band_check(RGB_PROFILE, *bands_of(forest(200, 200)))
NO_DUP = duplicate_check([])


@pytest.mark.unit
def test_the_dataset_rule_excludes_when_both_models_do():
	rule = dataset_rule(calls(answer('exclude', 90, 'no_trees'), answer('exclude', 70, 'no_trees')), OK_BAND, NO_DUP)

	assert rule.assessor_kind == 'rule' and rule.model == 'dataset-evaluation-rule'
	assert rule.verdict == 'major' and rule.major_likelihood == 80
	assert rule.details['reason'] == 'no_trees' and rule.details['why'] == ['models_exclude']


@pytest.mark.unit
def test_the_dataset_rule_sends_disagreement_and_flags_to_a_person():
	split = dataset_rule(calls(answer('exclude', 95, 'blurry'), answer('keep', 10)), OK_BAND, NO_DUP)
	assert split.verdict == 'unsure' and split.details['why'] == ['models_disagree']

	duplicate = duplicate_check([{'dataset_id': 4, 'kind': 'same_file', 'hamming': 0, 'overlap': 1.0}])
	flagged = dataset_rule(calls(answer(), answer()), OK_BAND, duplicate)
	assert flagged.verdict == 'unsure' and flagged.modes['duplicate']['likelihood'] == 95


@pytest.mark.unit
def test_a_clear_band_failure_excludes_even_when_the_models_keep():
	gray = np.repeat(forest(200, 200)[..., :1], 3, axis=2)
	rule = dataset_rule(calls(answer(), answer()), band_check(RGB_PROFILE, *bands_of(gray)), NO_DUP)

	assert rule.verdict == 'major' and rule.details['reason'] == 'not_rgb'


@pytest.mark.unit
def test_fix_flags_keep_the_dataset_but_mark_it_for_fixing():
	rule = dataset_rule(
		calls(answer('keep', 5, thumbnail_issue=80), answer('fix', 10, thumbnail_issue=70)), OK_BAND, NO_DUP
	)
	assert rule.verdict == 'minor' and rule.modes['thumbnail_issue']['likelihood'] == 75

	assert dataset_rule(calls(answer(), answer()), OK_BAND, NO_DUP).verdict == 'ok'


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
	inputs = read_inputs(str(cog), aoi_box(0, 0, 4000, 1500), seed=3, overview_px=1024, crop_px=512)
	luna, haiku = Fake(answer()), Fake(answer('fix', 20, reprocess=60))
	image_hash = phash(inputs.overview, inputs.valid)
	evaluation = evaluate(
		inputs,
		{'luna-medium': luna, 'haiku-5.5': haiku},
		ortho_sha256=SHA,
		source_profile=RGB_PROFILE,
		image_hash=image_hash,
		duplicate_candidates=[],
		thumbnail=thumbnail_bytes(),
		aoi_key='abc',
	)

	assert len(luna.images[0]) == 6 and all(isinstance(i, Image.Image) for i in luna.images[0])
	assert luna.images[0][0].size == (1024, 768)
	assert 'magenta line' in luna.prompts[0] and 'Image 6 is the 256 px thumbnail' in luna.prompts[0]
	# the models and the dataset verdict are the stored rows; the rules it folds in are run evidence
	assert [c.model for c in evaluation.calls] == ['luna-medium', 'haiku-5.5', 'dataset-evaluation-rule']
	assert [c.model for c in evaluation.rules] == ['band_check', 'duplicates']
	assert evaluation.evidence['rules']['band_check']['verdict'] == 'ok'
	assert evaluation.evidence['rules']['duplicates'] == {
		'version': 'v1',
		'verdict': 'ok',
		'likelihood': 0.0,
		'details': {'candidates': []},
	}
	assert evaluation.verdict.verdict == 'minor'
	assert evaluation.calls[1].raw['attempt'] == 1 and evaluation.cost['haiku-5.5']['cost_usd'] is None
	# the run's identity has the shape of handler.inputs(); the crop settings are evidence
	assert evaluation.inputs == {'ortho_sha256': SHA, 'aoi': 'abc'}
	assert evaluation.evidence['settings'] == inputs.settings

	payload = store_payload(evaluation, inputs, 42, SHA)
	assert [i['kind'] for i in payload['images']] == ['overview', 'raw', 'raw', 'raw', 'raw', 'thumbnail']
	assert [i['crop_index'] for i in payload['images']] == [None, 1, 2, 3, 4, None]
	# files are named by content: another run on this ortho cannot overwrite them
	overview = evaluation.images[0]
	assert payload['images'][0]['storage_path'] == (
		f'audit/dataset_evaluation/42/{SHA[:16]}/overview-{overview.sha256[:16]}.jpg'
	)
	assert payload['images'][0]['sha256'] == overview.sha256
	assert len({i['storage_path'] for i in payload['images']}) == 6
	assert [a['model'] for a in payload['assessments']] == ['luna-medium', 'haiku-5.5', 'dataset-evaluation-rule']
	assert len(payload['crops']) == 4 and payload['crops'][0]['pixel_window'] is None
	assert payload['crops'][0]['selection']['picker'] == 'kmeans-inside-v1'
	assert payload['phash'] == {'method': 'phash-dct64-v1', 'value': image_hash}
	json.dumps(payload)  # the RPC argument must serialise


@pytest.mark.unit
def test_the_overview_shows_the_aoi_edge_and_hides_no_data(cog):
	inputs = read_inputs(str(cog), aoi_box(1000, 500, 3000, 2500), overview_px=1024, crop_px=256)
	shown = check_module.overview_image(inputs)

	assert (shown[~inputs.valid] == 0).all()
	assert (shown == check_module.AOI_COLOUR).all(axis=2).sum() > 1000


@pytest.mark.unit
def test_a_malformed_reply_is_asked_again_once_and_login_errors_reach_the_worker(cog):
	inputs = read_inputs(str(cog), overview_px=512, crop_px=256)
	common = dict(ortho_sha256=SHA, source_profile=RGB_PROFILE, image_hash=0, duplicate_candidates=[])

	luna = Fake('not json', answer())
	assert evaluate(inputs, {'luna-medium': luna, 'haiku-5.5': Fake(answer())}, **common).verdict.verdict == 'ok'
	assert len(luna.prompts) == 2

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
	prompt = build_prompt(0.4, 0.03, has_aoi=False, has_thumbnail=False)

	assert 'about 40 cm per pixel' in prompt and 'about 3.0 cm per pixel' in prompt
	assert 'Images 2 to 5 are 4 samples' in prompt
	assert 'Image 6' not in prompt and 'judge the whole image' in prompt
	assert '"reason": "blurry | no_trees | artifacts | not_rgb | broken_ortho | too_dark | other | none"' in prompt


@pytest.mark.unit
def test_the_aoi_key_is_stable():
	aoi = aoi_box(0, 0, 10, 10)
	assert aoi_key(aoi) == aoi_key(json.loads(json.dumps(aoi))) and len(aoi_key(aoi)) == 16
	assert aoi_key(None) is None


# ---------------------------------------------------------------------------
# The worker handler, with PostgREST, storage and the judges faked at their boundaries
# ---------------------------------------------------------------------------


class Rows:
	"""Enough of a PostgREST table: select / eq / order / range / execute."""

	def __init__(self, rows):
		self.rows, self.filters, self.span = rows, [], None

	def select(self, *_):
		return Rows(self.rows)

	def eq(self, key, value):
		self.filters.append((key, value))
		return self

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
		return Rows(self.tables.get(name, []))

	def schema(self, name):
		assert name == 'audit'
		return self

	def rpc(self, name, args):
		self.calls.append((name, args))
		data = (
			[{'dataset_id': 9, 'kind': 'same_flight_day', 'hamming': 30, 'overlap': 0.9}]
			if name == 'duplicate_candidates'
			else None
		)
		return SimpleNamespace(execute=lambda: SimpleNamespace(data=data))


@pytest.mark.unit
def test_the_handler_uploads_the_images_before_it_stores_the_rows(cog, tmp_path, monkeypatch):
	monkeypatch.setattr(handler, 'local_cog', lambda *args: cog)
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
	events = []
	client.rpc = (lambda rpc: lambda name, args: (events.append(name), rpc(name, args))[1])(client.rpc)
	ctx = SimpleNamespace(
		run={'id': 7, 'dataset_id': 42},
		client=client,
		token='t',
		judges={
			'luna-medium': Fake(answer('exclude', 90, 'blurry')),
			'haiku-5.5': Fake(answer('exclude', 80, 'blurry')),
		},
		put_image=lambda path, data, dataset_id: events.append(path),
	)
	summary = handler.handle(ctx)

	assert events[0] == 'duplicate_candidates' and events[-1] == 'store_dataset_evaluation'
	assert len(events) == 8
	assert events[1].rsplit('/', 1)[1].startswith('overview-') and events[6].rsplit('/', 1)[1].startswith('thumbnail-')
	stored = dict(client.calls)['store_dataset_evaluation']
	assert stored['p_run_id'] == 7
	assert [a['model'] for a in stored['p_result']['assessments']] == [
		'luna-medium',
		'haiku-5.5',
		'dataset-evaluation-rule',
	]
	assert stored['p_result']['assessments'][-1]['verdict'] == 'major'
	assert summary['evidence']['rules']['duplicates']['verdict'] == 'unsure'  # the same-day duplicate flag
	assert summary['coverage'] == {'crops': 4, 'crop_picker': 'kmeans-inside-v1'}
	assert set(summary) == {'inputs', 'evidence', 'coverage', 'cost'}
	assert set(summary['inputs']) == {'ortho_sha256', 'aoi'}


@pytest.mark.unit
def test_the_handler_runs_after_the_cog_thumbnail_and_tiles_and_is_registered():
	from processor.src.audit_worker import worker

	assert worker.HANDLERS['dataset_evaluation'] == 'processor.src.dataset_evaluation_v1.handler'
	handlers, missing = worker.load_handlers()
	assert not missing and handlers['dataset_evaluation'].VERSION == 'v1'
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
def test_a_cog_without_a_usable_image_is_excluded_by_rule_without_a_model(tmp_path, kept):
	rgb = np.zeros((1200, 1600, 3), np.uint8)
	rgb[:kept, :kept] = forest(max(kept, 1), max(kept, 1))[:kept, :kept]  # a few stray pixels at most
	empty = write_cog(tmp_path / 'empty.tif', rgb)
	inputs = read_inputs(str(empty), overview_px=512, tiles=[Tile((0, 0, 512, 512), (7.8157, 48.0185))])

	assert inputs.empty and inputs.crops == [] and inputs.settings['crop_picker'] is None
	evaluation = evaluate(
		inputs,
		{'luna-medium': never, 'haiku-5.5': never},
		ortho_sha256=SHA,
		source_profile=RGB_PROFILE,
		image_hash=None,
		duplicate_candidates=[],
		thumbnail=thumbnail_bytes(),
	)
	(call,) = evaluation.calls
	assert (call.assessor_kind, call.model, call.prompt_version, call.verdict) == ('rule', 'empty_cog', 'v1', 'major')
	assert call.modes == {'broken_ortho': {'likelihood': 100.0}} and call.details['reason'] == 'broken_ortho'
	payload = store_payload(evaluation, inputs, 3327, SHA)
	assert 'phash' not in payload and payload['crops'] == []
	assert [i['kind'] for i in payload['images']] == ['overview', 'thumbnail']
	json.dumps(payload)


@pytest.mark.unit
def test_the_handler_skips_the_duplicate_lookup_for_an_empty_cog(tmp_path, monkeypatch):
	empty = write_cog(tmp_path / 'empty.tif', np.zeros((800, 800, 3), np.uint8))
	monkeypatch.setattr(handler, 'local_cog', lambda *args: empty)
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
		put_image=lambda path, data, dataset_id: uploaded.append(path),
	)
	summary = handler.handle(ctx)

	assert [name for name, _ in client.calls] == ['store_dataset_evaluation']
	assert len(uploaded) == 1 and uploaded[0].startswith(f'audit/dataset_evaluation/42/{SHA[:16]}/overview-')
	assert summary['coverage'] == {'crops': 0, 'crop_picker': None} and summary['cost'] == {}


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
	prompt = build_prompt(0.4, 0.03, has_aoi=True, has_thumbnail=True, crop_count=crops)

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
def test_a_colour_ratio_guess_never_excludes_by_rule():
	"""Red soil or autumn foliage is red too: the ratio flags for a person, the models decide."""
	red = np.zeros((3, 64, 64), np.uint8)
	red[0], red[1], red[2] = 220, 90, 80
	red[:, ::2, ::2] += 9  # not three identical bands
	band = band_check(RGB_PROFILE, red, np.ones((64, 64), bool))

	assert band.details['findings'][0]['code'] == 'false_colour_red'
	assert band.major_likelihood == 85 and band.verdict == 'unsure'


@pytest.mark.unit
def test_a_model_that_votes_to_exclude_below_the_threshold_sends_the_dataset_to_a_person():
	ok = Call('rule', 'x', 'v1', 'ok', 0.0)
	models = [
		Call('model', 'luna-medium', 'v1', 'major', 55.0, details={'reason': 'blurry'}),
		Call('model', 'haiku-5.5', 'v1', 'major', 55.0, details={'reason': 'blurry'}),
	]
	verdict = dataset_rule(models, ok, ok)

	assert verdict.verdict == 'unsure' and verdict.details['why'] == ['model_excludes_below_threshold']
	assert verdict.details['reason'] == 'blurry'
