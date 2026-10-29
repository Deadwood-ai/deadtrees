"""Map a check result onto the audit check base tables (DT-1481 draft of 2026-10-29).

Pure functions: they return the rows to insert; the worker owns the connection, the storage
upload and the run lifecycle. Layer names follow the base tables ('forest_cover'), and every
model answer becomes one append-only audit_assessments row per crop and layer.
"""

from __future__ import annotations

import hashlib
import io

from .check import CheckResult
from .judge import PROMPT_VERSION
from .render import CROP_PX, judge_images
from .rule import RULE_VERSION

CHECK_KEY = 'prediction_quality'
LAYER_NAMES = {'deadwood': 'deadwood', 'forest': 'forest_cover'}
IMAGE_KINDS = (('raw', None), ('deadwood_overlay', 'deadwood'), ('forest_cover_overlay', 'forest'))
SELECTED_BY = 'pq-picker-v1'


def run_row(result: CheckResult, ortho_sha256: str, label_ids: dict, judges: dict) -> dict:
	return {
		'check_key': CHECK_KEY,
		'dataset_id': result.dataset_id,
		'inputs': {
			'ortho_sha256': ortho_sha256,
			'label_ids': {LAYER_NAMES[k]: v for k, v in label_ids.items()},
			'versions': result.versions,
			'models': judges,
		},
		'coverage': {
			'mode': 'sampled',
			'tiles_total': result.tiles_total,
			'crops': len(result.crops),
			'exclude_set': sum('exclude' in r.tile.sets for r in result.crops),
			'training_set': sum('training' in r.tile.sets for r in result.crops),
		},
		'evidence': {
			'rule': RULE_VERSION,
			'verdicts': {LAYER_NAMES[k]: v for k, v in result.verdicts.items()},
			'epsg': result.epsg,
			'seconds': result.seconds,
		},
	}


def crop_rows(result: CheckResult, ortho_sha256: str, footprint) -> list[dict]:
	"""One row per crop and set; footprint(tile) -> WGS84 polygon as GeoJSON."""
	rows = []
	for r in result.crops:
		for crop_set in r.tile.sets:
			x0, y0, x1, y1 = r.tile.pixel_window
			rows.append(
				{
					'dataset_id': result.dataset_id,
					'ortho_sha256': ortho_sha256,
					'crop_set': crop_set,
					'selected_by': SELECTED_BY,
					'pixel_x0': x0,
					'pixel_y0': y0,
					'pixel_x1': x1,
					'pixel_y1': y1,
					'geometry': footprint(r.tile),
					'mpp': r.crop.mpp,
					'size_px': CROP_PX,
					'selection': {
						'predicted': {'deadwood': r.tile.deadwood_share, 'forest_cover': r.tile.forest_share},
						'stratum': list(r.tile.stratum),
						'weight': r.tile.weight if crop_set == 'training' else None,
					},
					'_tile_id': r.tile.tile_id,  # worker-side key to attach images and assessments
				}
			)
	return rows


def image_rows(result: CheckResult, label_ids: dict) -> list[dict]:
	"""The three images per crop as JPEG bytes; the worker uploads them and fills storage_path."""
	rows = []
	for r in result.crops:
		for (kind, layer), image in zip(IMAGE_KINDS, judge_images(r.crop)):
			buf = io.BytesIO()
			image.save(buf, 'JPEG', quality=88)
			data = buf.getvalue()
			rows.append(
				{
					'dataset_id': result.dataset_id,
					'_tile_id': r.tile.tile_id,
					'label_id': label_ids.get(layer) if layer else None,
					'kind': kind,
					'content_type': 'image/jpeg',
					'width': CROP_PX,
					'height': CROP_PX,
					'mpp': r.crop.mpp,
					'bytes': len(data),
					'sha256': hashlib.sha256(data).hexdigest(),
					'_data': data,
				}
			)
	return rows


def assessment_rows(result: CheckResult, label_ids: dict) -> list[dict]:
	"""Per crop and judge: one 'image' row (the m0 gate) and one row per prediction layer."""
	rows = []
	for r in result.crops:
		for a in r.answers:
			base = {
				'check_key': CHECK_KEY,
				'dataset_id': result.dataset_id,
				'_tile_id': r.tile.tile_id,
				'assessor_kind': 'model',
				'model': a.judge,
				'prompt_version': PROMPT_VERSION,
			}
			rows.append(
				{
					**base,
					'layer': 'image',
					'label_id': None,
					'verdict': 'ok' if a.assessable else 'major',
					'major_likelihood': None,
					'modes': {'m0_assessable': {'likelihood': 100 if a.assessable else 0}},
					'details': {},
					'raw': {'text': a.raw},
				}
			)
			for layer, answer in a.layers.items():
				rows.append(
					{
						**base,
						'layer': LAYER_NAMES[layer],
						'label_id': label_ids.get(layer),
						'verdict': answer.verdict,
						'major_likelihood': answer.major_likelihood,
						'modes': answer.modes,
						'details': {'errors': answer.errors, 'area_pct': answer.area_pct},
						'raw': None,
					}
				)
	return rows
