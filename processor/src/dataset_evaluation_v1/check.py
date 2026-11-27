"""One dataset evaluation run: the images the models see, the model calls, the band check,
and the result as the p_result of audit.finish_run. Keep or exclude is the rules' call, made
in the database from the stored answers (audit.evaluation_calls).

The judges are the audit worker's backends (audit_worker.models): a function
(prompt, images) -> answer text per model name, images inline, no tools. Their login
and usage-limit errors propagate, so the worker pauses instead of failing the run."""

import hashlib
import io
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable, Sequence

import numpy as np
from PIL import Image
from shapely.geometry import mapping

from .bands import band_check
from .inputs import CROP_COUNT, CROP_MPP, CROP_PICKER, CROP_PX, GRID_PICKER, MIN_VALID_SHARE, OVERVIEW_PX, Inputs
from .prompt import ISSUE_AT, PROMPT_VERSION, AnswerError, Judgement, build_prompt, parse_answer
from .vocabulary import CHECK_KEY

JPEG_QUALITY = 90

# A judge: (prompt, PIL images) -> answer text (audit_worker.models.Backend).
Judge = Callable[[str, Sequence], str]

# audit.check_versions.config: everything that changes the answers. `models` is the
# worker's judge spec: Haiku through claude -p, Luna through the Codex login.
CONFIG = {
	'models': {
		'luna-medium': {'transport': 'codex', 'model': 'gpt-6-luna', 'effort': 'medium'},
		'haiku-5.5': {'transport': 'claude', 'model': 'claude-haiku-5-5'},
	},
	'prompt_version': PROMPT_VERSION,
	'issue_at': ISSUE_AT,
	'min_valid_share': MIN_VALID_SHARE,
	'inputs': {
		'overview_px': OVERVIEW_PX,
		'crop_count': CROP_COUNT,
		'crop_picker': GRID_PICKER,
		'crop_mpp': CROP_MPP,
		'fallback': {'crop_picker': CROP_PICKER, 'crop_px': CROP_PX},
	},
}


@dataclass
class ImageFile:
	kind: str  # audit.images kind: overview, raw (a tile), thumbnail
	stem: str  # what the file shows: overview, tile-<n>, thumbnail
	data: bytes
	width: int
	height: int
	mpp: float | None
	tile_index: int | None = None  # 1-based, into the run's tiles

	@property
	def sha256(self) -> str:
		return hashlib.sha256(self.data).hexdigest()


@dataclass
class Evaluation:
	images: list[ImageFile]
	judgements: list[Judgement]  # one per model; none for an empty COG
	evidence: dict  # includes `empty` and, when the models were asked, the `band_check`
	cost: dict = field(default_factory=dict)


def jpeg(rgb: np.ndarray) -> bytes:
	out = io.BytesIO()
	Image.fromarray(rgb).save(out, 'JPEG', quality=JPEG_QUALITY)
	return out.getvalue()


def overview_image(inputs: Inputs) -> np.ndarray:
	"""The overview as the models see it: no-data black."""
	return np.where(inputs.valid[..., None], inputs.overview, 0).astype(np.uint8)


def model_images(inputs: Inputs, thumbnail: bytes | None) -> list[ImageFile]:
	h, w = inputs.overview.shape[:2]
	files = [ImageFile('overview', 'overview', jpeg(overview_image(inputs)), w, h, inputs.overview_mpp)]
	for i, crop in enumerate(inputs.crops, start=1):
		ch, cw = crop.image.shape[:2]
		files.append(ImageFile('raw', f'tile-{i}', jpeg(crop.image), cw, ch, crop.mpp, i))
	if thumbnail:
		with Image.open(io.BytesIO(thumbnail)) as im:
			tw, th = im.size
		files.append(ImageFile('thumbnail', 'thumbnail', thumbnail, tw, th, None))
	return files


def ask(name: str, judge: Judge, prompt: str, images: Sequence) -> Judgement:
	"""One judge's answer; a malformed reply is asked once more. Model errors propagate:
	the worker pauses on login and usage-limit errors and retries the run on others."""
	for attempt in (1, 2):
		started = time.monotonic()
		text = judge(prompt, images)
		try:
			call = parse_answer(text, name)
		except AnswerError:
			if attempt == 2:
				raise
			continue
		call.raw.update(seconds=round(time.monotonic() - started, 1), attempt=attempt)
		return call


def evaluate(
	inputs: Inputs,
	judges: dict[str, Judge],
	*,
	source_profile: dict | None,
	thumbnail: bytes | None = None,
) -> Evaluation:
	"""Ask the models and run the band check on one dataset's inputs. An empty COG is
	judged by no one: the rules exclude it as a broken ortho."""
	images = model_images(inputs, thumbnail)
	evidence = {
		'settings': inputs.settings,
		'native_mpp': round(inputs.native_mpp, 4),
		'overview_mpp': round(inputs.overview_mpp, 4),
		'size_px': list(inputs.size),
		'valid_share': round(inputs.valid_share, 4),
		'footprint': mapping(inputs.footprint),
		'prompt_version': PROMPT_VERSION,
		'empty': inputs.empty,
	}
	if inputs.empty:
		return Evaluation(images=images, judgements=[], evidence=evidence)
	crop_mpp = inputs.crops[0].mpp if inputs.crops else inputs.native_mpp
	prompt = build_prompt(inputs.overview_mpp, crop_mpp, thumbnail is not None, crop_count=len(inputs.crops))
	# Decoded here: the judges run in threads and must not share lazily loading files.
	pictures = [Image.open(io.BytesIO(f.data)).convert('RGB') for f in images]
	# Independent calls: the slower model sets the run time.
	with ThreadPoolExecutor(max_workers=len(judges)) as pool:
		answers = list(pool.map(lambda item: ask(*item, prompt, pictures), judges.items()))
	return Evaluation(
		images=images,
		judgements=answers,
		evidence={**evidence, 'band_check': band_check(source_profile, inputs.bands, inputs.valid)},
		# Subscription calls report no tokens or dollars; time and calls are what is known.
		cost={a.judge: {'seconds': a.raw['seconds'], 'calls': a.raw['attempt'], 'cost_usd': None} for a in answers},
	)


def image_path(dataset_id: int, run_id: int, image: ImageFile) -> str:
	"""Storage path relative to the storage server's data directory; one folder per run."""
	return f'audit/{CHECK_KEY}/{dataset_id}/run-{run_id}/{image.stem}.jpg'


def payload(evaluation: Evaluation, inputs: Inputs, dataset_id: int, run_id: int, judged: dict) -> dict:
	"""The p_result of audit.finish_run: what the run judged (`judged`, its inputs), its
	evidence, tiles, images and the models' judgements. The image files are uploaded first,
	to image_path()."""
	tiles = [
		{
			# the 10 cm CLIP grid window audit.tiles keys on; null for windows off the grid
			'pixel_window': list(crop.grid_window) if crop.grid_window else None,
			'geometry': mapping(crop.footprint),
			'mpp': round(crop.mpp, 5),
			'size_px': max(crop.image.shape[:2]),
		}
		for crop in inputs.crops
	]
	picked = [
		{'picker': crop.picker, **({'cog_window': list(crop.cog_window)} if crop.cog_window else {})}
		for crop in inputs.crops
	]
	return {
		'inputs': judged,
		'evidence': {
			**evaluation.evidence,
			'coverage': {'tiles': len(inputs.crops), 'tile_picker': inputs.settings['crop_picker']},
			'cost': evaluation.cost,
			'tiles': picked,
		},
		'tiles': tiles,
		'images': [
			{
				'tile_index': f.tile_index,
				'prediction_label_id': None,
				'kind': f.kind,
				'storage_path': image_path(dataset_id, run_id, f),
				'content_type': 'image/jpeg',
				'width': f.width,
				'height': f.height,
				'mpp': None if f.mpp is None else round(f.mpp, 5),
				'bytes': len(f.data),
				'sha256': f.sha256,
			}
			for f in evaluation.images
		],
		'dataset_judgements': [j.row() for j in evaluation.judgements],
		'tile_judgements': [],
	}
