"""One dataset evaluation run: the images the models see, the model calls, the rules
and the result as the payload of audit.store_dataset_evaluation.

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

from .inputs import CROP_COUNT, CROP_MPP, CROP_PICKER, CROP_PX, GRID_PICKER, MIN_VALID_SHARE, OVERVIEW_PX, Inputs
from .prompt import PROMPT_VERSION, AnswerError, build_prompt, parse_answer
from .rules import (
	BAND_RULE,
	DATASET_RULE,
	DUPLICATE_RULE,
	EMPTY_COG_RULE,
	PHASH_METHOD,
	RULE_CONFIG,
	Call,
	band_check,
	dataset_rule,
	duplicate_check,
	empty_cog,
)
from .vocabulary import CHECK_KEY

JPEG_QUALITY = 90
AOI_COLOUR = (255, 0, 255)

# A judge: (prompt, PIL images) -> answer text (audit_worker.models.Backend).
Judge = Callable[[str, Sequence], str]

# audit.check_versions.config of v1: everything that changes the result. `models` is
# the worker's judge spec: Haiku through claude -p, Luna through the Codex login.
CONFIG = {
	'models': {
		'luna-medium': {'transport': 'codex', 'model': 'gpt-6-luna', 'effort': 'medium'},
		'haiku-5.5': {'transport': 'claude', 'model': 'claude-haiku-5-5'},
	},
	'prompt_version': PROMPT_VERSION,
	'rules': {
		'band': '/'.join(BAND_RULE),
		'duplicates': '/'.join(DUPLICATE_RULE),
		'dataset': '/'.join(DATASET_RULE),
		'empty_cog': '/'.join(EMPTY_COG_RULE),
	},
	'rule_config': RULE_CONFIG,
	'min_valid_share': MIN_VALID_SHARE,
	'phash': PHASH_METHOD,
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
	kind: str  # audit.images kind: overview, raw (a crop), thumbnail
	name: str  # file name inside the run's storage folder
	data: bytes
	width: int
	height: int
	mpp: float | None
	crop_index: int | None = None

	@property
	def sha256(self) -> str:
		return hashlib.sha256(self.data).hexdigest()


@dataclass
class Evaluation:
	images: list[ImageFile]
	calls: list[Call]  # models first, then band, duplicates and the dataset rule
	phash: int | None  # None when there was no image to hash
	inputs: dict
	evidence: dict
	cost: dict = field(default_factory=dict)

	@property
	def verdict(self) -> Call:
		return self.calls[-1]


def jpeg(rgb: np.ndarray) -> bytes:
	out = io.BytesIO()
	Image.fromarray(rgb).save(out, 'JPEG', quality=JPEG_QUALITY)
	return out.getvalue()


def overview_image(inputs: Inputs) -> np.ndarray:
	"""The overview as the models see it: no-data black, the AOI edge in magenta."""
	rgb = np.where(inputs.valid[..., None], inputs.overview, 0).astype(np.uint8)
	if inputs.aoi is None:
		return rgb
	inside = inputs.aoi
	edge = inside & ~(np.roll(inside, 1, 0) & np.roll(inside, -1, 0) & np.roll(inside, 1, 1) & np.roll(inside, -1, 1))
	edge = edge | np.roll(edge, 1, 0) | np.roll(edge, 1, 1)  # two pixels wide
	rgb[edge] = AOI_COLOUR
	return rgb


def model_images(inputs: Inputs, thumbnail: bytes | None) -> list[ImageFile]:
	h, w = inputs.overview.shape[:2]
	files = [ImageFile('overview', 'overview.jpg', jpeg(overview_image(inputs)), w, h, inputs.overview_mpp)]
	for i, crop in enumerate(inputs.crops):
		ch, cw = crop.image.shape[:2]
		files.append(ImageFile('raw', f'crop-{i + 1}.jpg', jpeg(crop.image), cw, ch, crop.mpp, i))
	if thumbnail:
		with Image.open(io.BytesIO(thumbnail)) as im:
			tw, th = im.size
		files.append(ImageFile('thumbnail', 'thumbnail.jpg', thumbnail, tw, th, None))
	return files


def ask(name: str, judge: Judge, prompt: str, images: Sequence) -> Call:
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
		call.raw = {'text': text[:20000], 'seconds': round(time.monotonic() - started, 1), 'attempt': attempt}
		return call


def evaluate(
	inputs: Inputs,
	judges: dict[str, Judge],
	*,
	ortho_sha256: str,
	source_profile: dict | None,
	image_hash: int | None,
	duplicate_candidates: list[dict],
	thumbnail: bytes | None = None,
	aoi_key: str | None = None,
) -> Evaluation:
	"""Run the rules and the models on one dataset's inputs. `image_hash` is the
	overview's phash, which the caller needs first to look up duplicate candidates."""
	images = model_images(inputs, thumbnail)
	identity = {'ortho_sha256': ortho_sha256, 'aoi': aoi_key, **inputs.settings}
	evidence = {
		'native_mpp': round(inputs.native_mpp, 4),
		'overview_mpp': round(inputs.overview_mpp, 4),
		'size_px': list(inputs.size),
		'valid_share': round(inputs.valid_share, 4),
		'aoi_share': None if inputs.aoi is None else round(float(inputs.aoi.mean()), 4),
		'footprint': mapping(inputs.footprint),
		'prompt_version': PROMPT_VERSION,
	}
	if inputs.empty:
		# Nothing to look at: the rule decides, no model is asked.
		return Evaluation(
			images=images, calls=[empty_cog(inputs.valid_share)], phash=None, inputs=identity, evidence=evidence
		)
	crop_mpp = inputs.crops[0].mpp if inputs.crops else inputs.native_mpp
	prompt = build_prompt(inputs.overview_mpp, crop_mpp, inputs.aoi is not None, thumbnail is not None)
	# Decoded here: the judges run in threads and must not share lazily loading files.
	pictures = [Image.open(io.BytesIO(f.data)).convert('RGB') for f in images]
	# Independent calls: the slower model sets the run time.
	with ThreadPoolExecutor(max_workers=len(judges)) as pool:
		answers = list(pool.map(lambda item: ask(*item, prompt, pictures), judges.items()))
	band = band_check(source_profile, inputs.bands, inputs.valid)
	duplicates = duplicate_check(duplicate_candidates)
	verdict = dataset_rule(answers, band, duplicates)
	return Evaluation(
		images=images,
		calls=[*answers, band, duplicates, verdict],
		phash=image_hash,
		inputs=identity,
		evidence={**evidence, 'phash': {'method': PHASH_METHOD, 'value': str(image_hash)}},
		# Subscription calls report no tokens or dollars; time and calls are what is known.
		cost={a.model: {'seconds': a.raw['seconds'], 'calls': a.raw['attempt'], 'cost_usd': None} for a in answers},
	)


def storage_folder(dataset_id: int, ortho_sha256: str) -> str:
	"""Where a run's images live, relative to the storage server's data directory.
	Images are per ortho, so reruns on the same ortho reuse the stored files."""
	return f'audit/{CHECK_KEY}/{dataset_id}/{ortho_sha256[:16]}'


def store_payload(evaluation: Evaluation, inputs: Inputs, dataset_id: int, ortho_sha256: str) -> dict:
	"""The p_result argument of audit.store_dataset_evaluation: the run's evidence rows.
	The run row itself (status, evidence, coverage, cost) is the worker's to finish."""
	folder = storage_folder(dataset_id, ortho_sha256)
	crops = [
		{
			# the 10 cm CLIP grid window audit.crops keys on; null for crops off the grid
			'pixel_window': list(crop.grid_window) if crop.grid_window else None,
			'geometry': mapping(crop.footprint),
			'mpp': round(crop.mpp, 5),
			'size_px': max(crop.image.shape[:2]),
			'selection': {
				'picker': crop.picker,
				'index': i + 1,
				'seed': inputs.settings['seed'],
				**({'cog_window': list(crop.cog_window)} if crop.cog_window else {}),
			},
		}
		for i, crop in enumerate(inputs.crops)
	]
	return {
		'ortho_sha256': ortho_sha256,
		'crops': crops,
		'images': [
			{
				'kind': f.kind,
				'crop_index': None if f.crop_index is None else f.crop_index + 1,
				'storage_path': f'{folder}/{f.name}',
				'content_type': 'image/jpeg',
				'width': f.width,
				'height': f.height,
				'mpp': None if f.mpp is None else round(f.mpp, 5),
				'bytes': len(f.data),
				'sha256': f.sha256,
			}
			for f in evaluation.images
		],
		'assessments': [c.row() for c in evaluation.calls],
		**({'phash': {'method': PHASH_METHOD, 'value': evaluation.phash}} if evaluation.phash is not None else {}),
	}
