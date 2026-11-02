"""One dataset evaluation run: the images the models see, the model calls, the rules
and the result as the payload of audit.store_dataset_evaluation."""

import hashlib
import io
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import numpy as np
from PIL import Image
from shapely.geometry import mapping

from .inputs import CROP_COUNT, CROP_MPP, CROP_PICKER, CROP_PX, GRID_PICKER, OVERVIEW_PX, Inputs
from .models import Model, ModelBusy
from .prompt import PROMPT_VERSION, AnswerError, build_prompt, parse_answer
from .rules import (
	BAND_RULE,
	DATASET_RULE,
	DUPLICATE_RULE,
	PHASH_METHOD,
	RULE_CONFIG,
	Call,
	band_check,
	dataset_rule,
	duplicate_check,
)
from .vocabulary import CHECK_KEY

VERSION = 'v1'
JPEG_QUALITY = 90
AOI_COLOUR = (255, 0, 255)
BUSY_PAUSES_S = (10, 30, 90)

# audit.check_versions.config of this version: everything that changes the result.
CONFIG = {
	'models': ['luna-medium', 'haiku-5.5'],
	'prompt_version': PROMPT_VERSION,
	'rules': {'band': '/'.join(BAND_RULE), 'duplicates': '/'.join(DUPLICATE_RULE), 'dataset': '/'.join(DATASET_RULE)},
	'rule_config': RULE_CONFIG,
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
	phash: int
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


def ask(model: Model, prompt: str, images: list[tuple[str, bytes]]) -> Call:
	"""One model's answer; capacity errors wait and retry, a malformed reply is asked once more.
	ModelUnavailable propagates so the worker keeps the run queued."""
	malformed = 0
	for pause in (*BUSY_PAUSES_S, None):
		try:
			reply = model(prompt, images)
			call = parse_answer(reply.text, model.name)
			call.raw = {'text': reply.text[:20000], 'usage': reply.usage, 'seconds': reply.seconds}
			return call
		except ModelBusy:
			if pause is None:
				raise
			time.sleep(pause)
		except AnswerError:
			malformed += 1
			if malformed > 1:
				raise
	raise ModelBusy(f'{model.name} stayed busy')


def evaluate(
	inputs: Inputs,
	models: list[Model],
	*,
	ortho_sha256: str,
	source_profile: dict | None,
	image_hash: int,
	duplicate_candidates: list[dict],
	thumbnail: bytes | None = None,
	aoi_key: str | None = None,
) -> Evaluation:
	"""Run the rules and the models on one dataset's inputs. `image_hash` is the
	overview's phash, which the caller needs first to look up duplicate candidates."""
	images = model_images(inputs, thumbnail)
	crop_mpp = inputs.crops[0].mpp if inputs.crops else inputs.native_mpp
	prompt = build_prompt(inputs.overview_mpp, crop_mpp, inputs.aoi is not None, thumbnail is not None)
	named = [(f'image{i + 1}.jpg', f.data) for i, f in enumerate(images)]
	# Independent calls: the slower model sets the run time.
	with ThreadPoolExecutor(max_workers=len(models)) as pool:
		answers = list(pool.map(lambda m: ask(m, prompt, named), models))
	band = band_check(source_profile, inputs.bands, inputs.valid)
	duplicates = duplicate_check(duplicate_candidates)
	verdict = dataset_rule(answers, band, duplicates)
	return Evaluation(
		images=images,
		calls=[*answers, band, duplicates, verdict],
		phash=image_hash,
		# The judged identity: a prompt change keeps reviews, a new ortho or AOI reopens them.
		inputs={'ortho_sha256': ortho_sha256, 'aoi': aoi_key, **inputs.settings},
		evidence={
			'native_mpp': round(inputs.native_mpp, 4),
			'overview_mpp': round(inputs.overview_mpp, 4),
			'size_px': list(inputs.size),
			'valid_share': round(float(inputs.valid.mean()), 4),
			'aoi_share': None if inputs.aoi is None else round(float(inputs.aoi.mean()), 4),
			'footprint': mapping(inputs.footprint),
			'phash': {'method': PHASH_METHOD, 'value': str(image_hash)},
			'prompt_version': PROMPT_VERSION,
		},
		cost={a.model: a.raw.get('usage', {}) | {'seconds': a.raw.get('seconds')} for a in answers},
	)


def storage_folder(dataset_id: int, ortho_sha256: str) -> str:
	"""Where a run's images live, relative to the storage server's data directory.
	Images are per ortho, so reruns on the same ortho reuse the stored files."""
	return f'audit/{CHECK_KEY}/{dataset_id}/{ortho_sha256[:16]}'


def store_payload(evaluation: Evaluation, inputs: Inputs, dataset_id: int, ortho_sha256: str) -> dict:
	"""The p_result argument of audit.store_dataset_evaluation."""
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
		'inputs': evaluation.inputs,
		'evidence': evaluation.evidence,
		'coverage': {'crops': len(inputs.crops), 'overview_px': max(inputs.overview.shape[:2])},
		'cost': evaluation.cost,
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
		'phash': {'method': PHASH_METHOD, 'value': evaluation.phash},
	}
