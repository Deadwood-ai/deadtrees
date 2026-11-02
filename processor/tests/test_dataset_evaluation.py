"""Dataset evaluation check v1: inputs from the COG, band and duplicate rules, the model
answer, the dataset rule and the model transports (external models faked at their
process and HTTP boundaries)."""

import io
import json
import os
import stat
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import numpy as np
import pytest
import rasterio
from PIL import Image, ImageDraw
from rasterio.transform import from_origin

from processor.src.dataset_evaluation_v1 import check as check_module
from processor.src.dataset_evaluation_v1.check import evaluate, store_payload
from processor.src.dataset_evaluation_v1.inputs import inside, padding, read_inputs
from processor.src.dataset_evaluation_v1.models import HaikuCLI, LunaResponses, ModelBusy, ModelUnavailable, Reply
from processor.src.dataset_evaluation_v1.prompt import AnswerError, build_prompt, parse_answer
from processor.src.dataset_evaluation_v1.rules import (
	band_check,
	dataset_rule,
	duplicate_check,
	hamming,
	phash,
)
from processor.src.process_dataset_evaluation import aoi_key

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
		col, row, w, h = crop.window
		assert crop.image.shape == (512, 512, 3) and (w, h) == (512, 512)
		assert col + w / 2 >= 1900  # centred in the AOI half
	cols = sorted(c.window[0] for c in inputs.crops)
	assert cols[-1] - cols[0] > 600  # spread out, not clustered


@pytest.mark.unit
def test_crops_are_the_same_on_a_rerun_and_move_with_the_seed(cog):
	first = [c.window for c in read_inputs(str(cog), seed=11, overview_px=512, crop_px=256).crops]
	again = [c.window for c in read_inputs(str(cog), seed=11, overview_px=512, crop_px=256).crops]
	other = [c.window for c in read_inputs(str(cog), seed=12, overview_px=512, crop_px=256).crops]

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
	assert all(c.window[0] >= 500 for c in inputs.crops)
	assert all((c.image < 250).any(axis=2).mean() > 0.95 for c in inputs.crops)


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
	def __init__(self, name, *replies):
		self.name, self.replies, self.prompts, self.images = name, list(replies), [], []

	def __call__(self, prompt, images):
		self.prompts.append(prompt)
		self.images.append(images)
		reply = self.replies.pop(0)
		if isinstance(reply, Exception):
			raise reply
		return Reply(reply, {'input_tokens': 1000, 'output_tokens': 100}, 2.5)


def thumbnail_bytes():
	out = io.BytesIO()
	Image.fromarray(forest(256, 256)).save(out, 'JPEG')
	return out.getvalue()


@pytest.mark.unit
def test_a_run_judges_six_images_and_stores_every_answer(cog):
	inputs = read_inputs(str(cog), aoi_box(0, 0, 4000, 1500), seed=3, overview_px=1024, crop_px=512)
	luna, haiku = Fake('luna-medium', answer()), Fake('haiku-5.5', answer('fix', 20, reprocess=60))
	image_hash = phash(inputs.overview, inputs.valid)
	evaluation = evaluate(
		inputs,
		[luna, haiku],
		ortho_sha256=SHA,
		source_profile=RGB_PROFILE,
		image_hash=image_hash,
		duplicate_candidates=[],
		thumbnail=thumbnail_bytes(),
		aoi_key='abc',
	)

	assert [n for n, _ in luna.images[0]] == [f'image{i}.jpg' for i in range(1, 7)]
	assert 'magenta line' in luna.prompts[0] and 'Image 6 is the 256 px thumbnail' in luna.prompts[0]
	assert [c.model for c in evaluation.calls] == [
		'luna-medium',
		'haiku-5.5',
		'band_check',
		'duplicates',
		'dataset-evaluation-rule',
	]
	assert evaluation.verdict.verdict == 'minor'
	assert evaluation.calls[1].raw['usage']['input_tokens'] == 1000
	assert evaluation.inputs == {
		'ortho_sha256': SHA,
		'aoi': 'abc',
		'overview_px': 1024,
		'crop_px': 512,
		'crop_count': 4,
		'crop_picker': 'kmeans-inside-v1',
		'seed': 3,
	}

	payload = store_payload(evaluation, inputs, 42, SHA)
	assert [i['kind'] for i in payload['images']] == ['overview', 'raw', 'raw', 'raw', 'raw', 'thumbnail']
	assert [i['crop_index'] for i in payload['images']] == [None, 1, 2, 3, 4, None]
	assert payload['images'][0]['storage_path'] == f'audit/dataset_evaluation/42/{SHA[:16]}/overview.jpg'
	assert len(payload['crops']) == 4 and payload['crops'][0]['geometry']['type'] == 'Polygon'
	assert payload['phash'] == {'method': 'phash-dct64-v1', 'value': image_hash}
	json.dumps(payload)  # the RPC argument must serialise


@pytest.mark.unit
def test_the_overview_shows_the_aoi_edge_and_hides_no_data(cog):
	inputs = read_inputs(str(cog), aoi_box(1000, 500, 3000, 2500), overview_px=1024, crop_px=256)
	shown = check_module.overview_image(inputs)

	assert (shown[~inputs.valid] == 0).all()
	assert (shown == check_module.AOI_COLOUR).all(axis=2).sum() > 1000


@pytest.mark.unit
def test_a_malformed_reply_is_asked_again_once_and_busy_models_wait(cog, monkeypatch):
	monkeypatch.setattr(check_module.time, 'sleep', lambda s: None)
	inputs = read_inputs(str(cog), overview_px=512, crop_px=256)
	common = dict(ortho_sha256=SHA, source_profile=RGB_PROFILE, image_hash=0, duplicate_candidates=[])

	luna = Fake('luna-medium', 'not json', answer())
	haiku = Fake('haiku-5.5', ModelBusy('overloaded'), answer())
	assert evaluate(inputs, [luna, haiku], **common).verdict.verdict == 'ok'

	with pytest.raises(AnswerError):
		evaluate(inputs, [Fake('luna-medium', 'no', 'still no'), Fake('haiku-5.5', answer())], **common)
	with pytest.raises(ModelUnavailable):
		evaluate(inputs, [Fake('luna-medium', answer()), Fake('haiku-5.5', ModelUnavailable('login'))], **common)


@pytest.mark.unit
def test_the_prompt_lists_only_the_reasons_the_models_decide():
	prompt = build_prompt(0.4, 0.03, has_aoi=False, has_thumbnail=False)

	assert 'about 40 cm per pixel' in prompt and 'about 3.0 cm per pixel' in prompt
	assert 'Image 6' not in prompt and 'judge the whole image' in prompt
	assert '"reason": "blurry | no_trees | artifacts | not_rgb | broken_ortho | too_dark | other | none"' in prompt


@pytest.mark.unit
def test_the_aoi_key_is_stable():
	aoi = aoi_box(0, 0, 10, 10)
	assert aoi_key(aoi) == aoi_key(json.loads(json.dumps(aoi))) and len(aoi_key(aoi)) == 16
	assert aoi_key(None) is None


# ---------------------------------------------------------------------------
# Model transports at their boundaries
# ---------------------------------------------------------------------------


def fake_claude(tmp_path, stdout: str, code: int = 0) -> str:
	"""A `claude` executable that records its arguments and the files it was given."""
	script = tmp_path / 'claude'
	(tmp_path / 'stdout.txt').write_text(stdout)
	script.write_text(
		'#!/bin/sh\n'
		f'printf "%s\\n" "$@" > {tmp_path}/args.txt\n'
		f'ls > {tmp_path}/files.txt\n'
		f'cat {tmp_path}/stdout.txt\n'
		f'exit {code}\n'
	)
	script.chmod(script.stat().st_mode | stat.S_IEXEC)
	return str(script)


@pytest.mark.unit
def test_haiku_runs_headless_with_only_the_read_tool(tmp_path):
	result = {
		'result': answer(),
		'num_turns': 7,
		'is_error': False,
		'modelUsage': {'claude-haiku-5-5': {'inputTokens': 100, 'cacheReadInputTokens': 9000, 'outputTokens': 300}},
	}
	haiku = HaikuCLI(binary=fake_claude(tmp_path, json.dumps(result)))
	reply = haiku('the prompt', [('image1.jpg', b'a'), ('image2.jpg', b'b')])

	assert parse_answer(reply.text, haiku.name).verdict == 'ok'
	assert reply.usage == {'input_tokens': 9100, 'output_tokens': 300, 'turns': 7, 'cost_usd': None}
	args = (tmp_path / 'args.txt').read_text().splitlines()
	assert args[args.index('--model') + 1] == 'claude-haiku-5-5'
	assert args[args.index('--tools') + 1] == 'Read' and '--strict-mcp-config' in args
	assert (tmp_path / 'files.txt').read_text().split() == ['image1.jpg', 'image2.jpg']


@pytest.mark.unit
def test_an_expired_claude_login_leaves_the_run_for_later(tmp_path):
	expired = {'is_error': True, 'result': 'OAuth token has expired. Please run /login'}
	with pytest.raises(ModelUnavailable):
		HaikuCLI(binary=fake_claude(tmp_path, json.dumps(expired), code=1))('p', [])
	with pytest.raises(ModelUnavailable):
		HaikuCLI(binary=str(tmp_path / 'missing'))('p', [])
	busy = {'is_error': True, 'result': 'API Error: 529 Overloaded'}
	with pytest.raises(ModelBusy):
		HaikuCLI(binary=fake_claude(tmp_path, json.dumps(busy), code=1))('p', [])


class OpenAIStub(BaseHTTPRequestHandler):
	status = 200
	seen = []

	def log_message(self, *args):
		pass

	def do_POST(self):
		body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
		OpenAIStub.seen.append((self.headers['Authorization'], body))
		reply = {
			'output': [
				{'type': 'message', 'content': [{'type': 'output_text', 'text': answer('exclude', 75, 'blurry')}]}
			],
			'usage': {'input_tokens': 4400, 'output_tokens': 900},
		}
		data = json.dumps(reply).encode()
		self.send_response(OpenAIStub.status)
		self.send_header('Content-Length', str(len(data)))
		self.end_headers()
		self.wfile.write(data)


@pytest.fixture
def openai_stub():
	server = HTTPServer(('127.0.0.1', 0), OpenAIStub)
	threading.Thread(target=server.serve_forever, daemon=True).start()
	OpenAIStub.status, OpenAIStub.seen = 200, []
	yield f'http://127.0.0.1:{server.server_port}/v1/responses'
	server.shutdown()


@pytest.mark.unit
def test_luna_sends_every_image_at_original_detail(tmp_path, openai_stub):
	key_file = tmp_path / 'openai.env'
	key_file.write_text('OPENAI_API_KEY=sk-test-not-real\n')
	os.chmod(key_file, 0o600)
	luna = LunaResponses(key_file, url=openai_stub)
	reply = luna('the prompt', [('image1.jpg', b'\xff\xd8a'), ('image2.jpg', b'\xff\xd8b')])

	assert parse_answer(reply.text, luna.name).verdict == 'major'
	assert reply.usage['input_tokens'] == 4400
	auth, body = OpenAIStub.seen[0]
	assert auth == 'Bearer sk-test-not-real'
	assert body['model'] == 'gpt-6-luna' and body['reasoning'] == {'effort': 'medium'}
	images = [c for c in body['input'][0]['content'] if c['type'] == 'input_image']
	assert len(images) == 2 and all(c['detail'] == 'original' for c in images)


@pytest.mark.unit
def test_luna_errors_map_to_retry_or_wait_for_login(tmp_path, openai_stub):
	key_file = tmp_path / 'openai.env'
	key_file.write_text('OPENAI_API_KEY=sk-test-not-real\n')
	OpenAIStub.status = 401
	with pytest.raises(ModelUnavailable):
		LunaResponses(key_file, url=openai_stub)('p', [])
	OpenAIStub.status = 429
	with pytest.raises(ModelBusy):
		LunaResponses(key_file, url=openai_stub)('p', [])
	with pytest.raises(ModelUnavailable):
		LunaResponses(tmp_path / 'missing.env', url=openai_stub)('p', [])
