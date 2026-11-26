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
from processor.src.dataset_evaluation_v1.check import evaluate, rule_only_verdict, store_payload
from processor.src.dataset_evaluation_v1.handler import tile_of
from processor.src.dataset_evaluation_v1.inputs import Tile, inside, padding, read_inputs
from processor.src.dataset_evaluation_v1.prompt import AnswerError, build_prompt, parse_answer
from processor.src.dataset_evaluation_v1.rules import Call, band_check, dataset_rule, empty_cog
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

	assert (call.assessor_kind, call.model, call.prompt_version) == ('model', 'haiku-5.5', 'v2')
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


@pytest.mark.unit
def test_the_dataset_rule_follows_haiku_and_shows_luna():
	# calls() gives Luna first, then Haiku
	rule = dataset_rule(calls(answer('keep', 5), answer('exclude', 70, 'no_trees')), OK_BAND)
	assert rule.assessor_kind == 'rule' and (rule.model, rule.prompt_version) == ('dataset-evaluation-rule', 'v3')
	assert rule.verdict == 'major' and rule.details['reason'] == 'no_trees' and rule.details['why'] == []
	assert rule.details['decider'] == 'haiku-5.5' and rule.details['models'] == {'luna-medium': 'ok', 'haiku-5.5': 'major'}

	kept = dataset_rule(calls(answer('exclude', 95, 'blurry'), answer('keep', 10)), OK_BAND)
	assert kept.verdict == 'ok' and kept.details['reason'] is None
	assert dataset_rule(calls(answer('keep', 5), answer('unsure', 50)), OK_BAND).verdict == 'unsure'
	# no Haiku answer: a person decides
	alone = dataset_rule(calls(answer('exclude', 95, 'blurry')), OK_BAND)
	assert alone.verdict == 'unsure' and alone.details['why'] == ['no_decider']


@pytest.mark.unit
def test_a_clear_band_failure_excludes_even_when_haiku_keeps_but_a_doubt_does_not():
	gray = np.repeat(forest(200, 200)[..., :1], 3, axis=2)
	rule = dataset_rule(calls(answer(), answer()), band_check(RGB_PROFILE, *bands_of(gray)))
	assert rule.verdict == 'major' and rule.details['reason'] == 'not_rgb'

	red = np.dstack([np.full((64, 64), v, np.uint8) for v in (220, 90, 80)])
	red[::2, ::2] += 9  # not three identical bands
	doubt = dataset_rule(calls(answer(), answer()), band_check(RGB_PROFILE, *bands_of(red)))
	assert doubt.verdict == 'ok' and 'duplicate' not in doubt.modes


@pytest.mark.unit
def test_a_fix_answer_keeps_the_dataset_and_haikus_issues_are_the_output():
	rule = dataset_rule(calls(answer('fix', 5, reprocess=80), answer('fix', 10, reprocess=70, thumbnail_issue=60)), OK_BAND)
	assert rule.verdict == 'ok' and rule.details['why'] == []
	assert rule.modes['reprocess']['likelihood'] == 70
	assert rule.output == {'cog_issue': False, 'thumbnail_issue': True}
	assert rule.row()['output'] == rule.output  # stored as audit.assessments.output
	# Luna's issue alone is shown, not counted; an excluded dataset still reports Haiku's issues
	assert dataset_rule(calls(answer('fix', 5, cog_issue=95), answer()), OK_BAND).output == {'cog_issue': False, 'thumbnail_issue': False}
	excluded = dataset_rule(calls(answer(), answer('exclude', 80, 'blurry', cog_issue=60)), OK_BAND)
	assert excluded.verdict == 'major' and excluded.output['cog_issue'] is True


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
	# the models and the dataset verdict are the stored rows; the rules it folds in are run evidence
	assert [c.model for c in evaluation.calls] == ['luna-medium', 'haiku-5.5', 'dataset-evaluation-rule']
	assert list(evaluation.evidence['rules']) == ['band_check']
	assert evaluation.evidence['rules']['band_check']['verdict'] == 'ok'
	assert 'phash' not in evaluation.evidence
	assert evaluation.verdict.verdict == 'ok'
	assert evaluation.verdict.output == {'cog_issue': False, 'thumbnail_issue': True}
	assert evaluation.calls[1].raw['attempt'] == 1 and evaluation.cost['haiku-5.5']['cost_usd'] is None
	assert evaluation.evidence['settings'] == inputs.settings  # the crop settings are evidence
	# the rule row says in words what the surer model saw
	assert evaluation.verdict.details['summary'] == evaluation.calls[1].details['summary']

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
	# only the rule row has an output; the models' answers have none
	assert [a['output'] for a in payload['assessments']] == [None, None, {'cog_issue': False, 'thumbnail_issue': True}]
	assert len(payload['crops']) == 4 and payload['crops'][0]['pixel_window'] is None
	assert payload['crops'][0]['selection']['picker'] == 'kmeans-inside-v1'
	assert set(payload) == {'ortho_sha256', 'crops', 'images', 'assessments'}  # no image hash any more
	json.dumps(payload)  # the RPC argument must serialise


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
		# store_dataset_evaluation answers the ids of the crops the run judged
		return SimpleNamespace(execute=lambda: SimpleNamespace(data=[11, 12, 13, 14]))


@pytest.mark.unit
def test_the_handler_uploads_the_images_before_it_stores_the_rows(cog, tmp_path, monkeypatch):
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
	events = []
	client.rpc = (lambda rpc: lambda name, args: (events.append(name), rpc(name, args))[1])(client.rpc)
	ctx = SimpleNamespace(
		run={'id': 7, 'dataset_id': 42},
		version={'version': 'v3', 'config': {'rule_config': {'decider': 'haiku', 'fix_at': 50}}},
		client=client,
		token='t',
		judges={
			'luna-medium': Fake(answer('exclude', 90, 'blurry')),
			'haiku-5.5': Fake(answer('exclude', 80, 'blurry')),
		},
		put_image=lambda path, data, dataset_id: events.append(path),
	)
	summary = handler.handle(ctx)

	# nothing is looked up before the files: the images go first, then the one store call
	assert [name for name, _ in client.calls] == ['store_dataset_evaluation']
	assert len(events) == 7 and events[-1] == 'store_dataset_evaluation'
	assert events[0].rsplit('/', 1)[1].startswith('overview-') and events[5].rsplit('/', 1)[1].startswith('thumbnail-')
	stored = dict(client.calls)['store_dataset_evaluation']
	assert stored['p_run_id'] == 7
	assert [a['model'] for a in stored['p_result']['assessments']] == [
		'luna-medium',
		'haiku-5.5',
		'dataset-evaluation-rule',
	]
	rule_row = stored['p_result']['assessments'][-1]
	assert rule_row['verdict'] == 'major' and rule_row['details']['decider'] == 'haiku-5.5'
	assert rule_row['output'] == {'cog_issue': False, 'thumbnail_issue': False}
	assert 'phash' not in stored['p_result'] and list(summary['evidence']['rules']) == ['band_check']
	assert summary['coverage'] == {'crops': 4, 'crop_picker': 'kmeans-inside-v1'}
	assert set(summary) == {'inputs', 'evidence', 'coverage', 'cost'}
	# the run's inputs have the one shape the queueing compares, and the run names what it judged
	assert summary['inputs'] == handler.inputs(client, 42) == {'ortho_sha256': SHA}
	judged = summary['evidence']['judged']
	assert judged['crop_ids'] == [11, 12, 13, 14]
	assert [i['kind'] for i in judged['images']] == ['overview', 'raw', 'raw', 'raw', 'raw', 'thumbnail']
	assert judged['images'][0]['storage_path'] == events[0]


@pytest.mark.unit
@pytest.mark.parametrize('earlier', ['v1', 'v2'])
def test_a_run_of_an_earlier_version_is_not_judged_by_this_code(earlier):
	"""Version 1 judged inside the AOI and version 2 had the duplicate check: their runs must not
	get this code's answers under their name, nor be recomputed with this code's rule."""
	ctx = SimpleNamespace(
		run={'id': 7, 'dataset_id': 42, 'source_run_id': 3},
		version={'version': earlier, 'config': {}},
		client=None,
		token='t',
	)
	with pytest.raises(ValueError, match=f'the run is of version {earlier}; this code judges v3'):
		handler.handle(ctx)
	with pytest.raises(ValueError, match=f'the run is of version {earlier}; this code judges v3'):
		handler.recompute(ctx)


@pytest.mark.unit
def test_the_handler_runs_after_the_cog_thumbnail_and_tiles_and_is_registered():
	from processor.src.audit_worker import worker

	assert worker.HANDLERS['dataset_evaluation'] == 'processor.src.dataset_evaluation_v1.handler'
	handlers, missing = worker.load_handlers()
	evaluation = handlers['dataset_evaluation']
	assert not missing and evaluation.VERSION == 'v3' and callable(evaluation.recompute)
	assert evaluation.CONFIG['rules'] == {
		'band': 'band_check/v1',
		'dataset': 'dataset-evaluation-rule/v3',
		'empty_cog': 'empty_cog/v1',
	}
	assert not {'duplicates', 'phash'} & set(evaluation.CONFIG)
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
		source_profile=RGB_PROFILE,
		thumbnail=thumbnail_bytes(),
	)
	(call,) = evaluation.calls
	assert (call.assessor_kind, call.model, call.prompt_version, call.verdict) == ('rule', 'empty_cog', 'v1', 'major')
	assert call.modes == {'broken_ortho': {'likelihood': 100.0}} and call.details['reason'] == 'broken_ortho'
	assert call.output == {'cog_issue': False, 'thumbnail_issue': False}  # no model raised a flag
	payload = store_payload(evaluation, inputs, 3327, SHA)
	assert payload['crops'] == []
	assert [i['kind'] for i in payload['images']] == ['overview', 'thumbnail']
	json.dumps(payload)


@pytest.mark.unit
def test_the_handler_stores_an_empty_cog_without_a_model_call(tmp_path, monkeypatch):
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
		put_image=lambda path, data, dataset_id: uploaded.append(path),
	)
	summary = handler.handle(ctx)

	assert [name for name, _ in client.calls] == ['store_dataset_evaluation']
	assert len(uploaded) == 1 and uploaded[0].startswith(f'audit/dataset_evaluation/42/{SHA[:16]}/overview-')
	assert summary['coverage'] == {'crops': 0, 'crop_picker': None} and summary['cost'] == {}


# ---------------------------------------------------------------------------
# Rule-only runs: this version's rule over an earlier run's stored answers
# ---------------------------------------------------------------------------

# A version 2 run's evidence: the band check, and the duplicate flag and image hash v3 ignores.
SOURCE_EVIDENCE = {
	'valid_share': 0.83,
	'rules': {
		'band_check': {'version': 'v1', 'verdict': 'ok', 'likelihood': 0.0, 'details': {'findings': []}},
		'duplicates': {
			'version': 'v1',
			'verdict': 'unsure',
			'likelihood': 70.0,
			'details': {'candidates': [{'dataset_id': 9, 'kind': 'same_flight_day'}]},
		},
	},
	'phash': {'method': 'phash-dct64-v1', 'value': '-123'},
	'judged': {'crop_ids': [11, 12, 13, 14]},
}
KEEP_FIX = (answer('fix', 10, reprocess=55, thumbnail_issue=60), answer('fix', 20, reprocess=60, thumbnail_issue=55))


def stored(call: Call, row_id: int, run_id: int = 5) -> dict:
	"""A call as audit.assessments holds it for the run."""
	return {**call.row(), 'id': row_id, 'run_id': run_id, 'crop_id': None, 'layer': 'image'}


def source_rows() -> list[dict]:
	"""The models' answers and the version 2 verdict (unsure: a possible duplicate), oldest first.
	An attempt retried after its store leaves an earlier row of the same model."""
	luna, haiku = calls(*KEEP_FIX)
	retried = parse_answer(answer('exclude', 99, 'blurry'), 'luna-medium')
	v2 = Call('rule', 'dataset-evaluation-rule', 'v2', 'unsure', 15.0, details={'why': ['duplicates']})
	return [stored(retried, 1), stored(luna, 2), stored(haiku, 3), stored(v2, 4)]


@pytest.mark.unit
def test_a_rule_only_run_recomputes_the_v3_verdict_from_the_stored_answers():
	verdict = rule_only_verdict(source_rows(), SOURCE_EVIDENCE)

	assert (verdict.assessor_kind, verdict.model, verdict.prompt_version) == ('rule', 'dataset-evaluation-rule', 'v3')
	# no duplicate flag any more, and asking for reprocessing keeps the dataset
	assert verdict.verdict == 'ok' and verdict.details['why'] == []
	assert verdict.output == {'cog_issue': False, 'thumbnail_issue': True}
	assert verdict.details['models'] == {'luna-medium': 'minor', 'haiku-5.5': 'minor'}  # the later row counts
	# the same call the rule makes on the answers when it is asked directly
	direct = dataset_rule(calls(*KEEP_FIX), OK_BAND)
	assert (verdict.verdict, verdict.modes, verdict.output) == (direct.verdict, direct.modes, direct.output)



@pytest.mark.unit
def test_a_rule_only_run_keeps_an_empty_cog_excluded_and_needs_answers():
	empty = rule_only_verdict([stored(empty_cog(0.001), 1)], {'valid_share': 0.001})
	assert (empty.model, empty.verdict) == ('empty_cog', 'major')
	assert empty.output == {'cog_issue': False, 'thumbnail_issue': False}

	v2_only = [r for r in source_rows() if r['assessor_kind'] == 'rule']
	with pytest.raises(ValueError, match='no model answers'):
		rule_only_verdict(v2_only, SOURCE_EVIDENCE)


@pytest.mark.unit
def test_recompute_stores_one_rule_row_and_takes_over_the_source_evidence():
	source = {
		'id': 5,
		'status': 'done',
		'inputs': {'ortho_sha256': SHA},
		'evidence': SOURCE_EVIDENCE,
		'coverage': {'crops': 4, 'crop_picker': 'clip-grid-kmeans-v1'},
	}
	client = FakeClient({'runs': [source], 'assessments': source_rows()})
	ctx = SimpleNamespace(
		run={'id': 9, 'dataset_id': 42, 'source_run_id': 5},
		version={'version': 'v3', 'config': {}},
		client=client,
		token='t',
		judges={},
	)
	summary = handler.recompute(ctx)

	(new,) = [r for r in client.tables['assessments'] if r['run_id'] == 9]
	assert (new['check_key'], new['dataset_id'], new['layer']) == ('dataset_evaluation', 42, 'image')
	assert (new['assessor_kind'], new['model'], new['prompt_version']) == ('rule', 'dataset-evaluation-rule', 'v3')
	assert new['verdict'] == 'ok' and new['output'] == {'cog_issue': False, 'thumbnail_issue': True}
	assert client.calls == []  # no store call: crops, images and model rows stay the source run's
	# the run judged the source's evidence: the queue sees the same inputs, the page the same crops
	assert summary == {key: source[key] for key in ('inputs', 'evidence', 'coverage')}

	source['status'] = 'failed'
	with pytest.raises(ValueError, match='source run 5 has not finished'):
		handler.recompute(ctx)


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
def test_a_colour_ratio_guess_never_excludes_by_rule():
	"""Red soil or autumn foliage is red too: the ratio flags for a person, the models decide."""
	red = np.zeros((3, 64, 64), np.uint8)
	red[0], red[1], red[2] = 220, 90, 80
	red[:, ::2, ::2] += 9  # not three identical bands
	band = band_check(RGB_PROFILE, red, np.ones((64, 64), bool))

	assert band.details['findings'][0]['code'] == 'false_colour_red'
	assert band.major_likelihood == 85 and band.verdict == 'unsure'


@pytest.mark.unit
def test_the_verdict_says_its_cause_in_words():
	ok = Call('rule', 'x', 'v1', 'ok', 0.0)
	models = [
		Call('model', 'luna-medium', 'v1', 'ok', 5.0, details={'reason': None, 'summary': 'Sharp forest scene.'}),
		Call('model', 'haiku-5.5', 'v1', 'ok', 10.0, details={'reason': None, 'summary': 'Usable forest image.'}),
	]
	gray = Call('rule', 'band_check', 'v1', 'major', 95.0, details={'findings': [{'likelihood': 95.0, 'why': 'one band'}]})
	assert dataset_rule(models, gray).details['summary'] == 'Not a true colour photo by the band check: one band. Usable forest image.'
	# without a rule cause the sentence is Haiku's own
	assert dataset_rule(models, ok).details['summary'] == 'Usable forest image.'
	assert dataset_rule(models[:1], ok).details['summary'] == 'The deciding model gave no answer.'


@pytest.mark.unit
def test_the_rule_runs_with_the_deciding_model_of_its_version():
	ok = Call('rule', 'x', 'v1', 'ok', 0.0)
	models = [
		Call('model', 'luna-medium', 'v1', 'major', 90.0, details={'reason': 'blurry'}),
		Call('model', 'haiku-5.5', 'v1', 'ok', 5.0, details={'reason': None}),
	]
	assert dataset_rule(models, ok).verdict == 'ok'
	assert dataset_rule(models, ok, {'decider': 'luna', 'fix_at': 50}).verdict == 'major'
