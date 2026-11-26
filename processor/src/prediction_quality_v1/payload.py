"""A prediction quality run as the p_result of audit.finish_run.

build() is pure: it returns the run's tiles, the images the judges saw and one judgement per
judge, tile and layer, plus the image files to upload before the call. finish_run stores the
rows and marks the run done in one transaction. Layer names follow the base tables
('forest_cover'). A judge that could not assess a tile answers not_assessable on both layers.
"""

from __future__ import annotations

import hashlib
import io

from .check import VERSIONS, CheckResult, TileResult
from .render import CROP_PX, judge_images

CHECK_KEY = 'prediction_quality'
LAYER_NAMES = {'deadwood': 'deadwood', 'forest': 'forest_cover'}
IMAGE_KINDS = (('raw', None), ('deadwood_overlay', 'deadwood'), ('forest_cover_overlay', 'forest'))
PICKER = 'windowed-v1'  # the sets are picked from tiles.CANDIDATES tiles the database draws


def evidence(result: CheckResult) -> dict:
	"""What the run records beside its rows: the sets each tile was picked for (by pixel
	window, as audit.tiles keys them), coverage, cost and versions."""
	return {
		'epsg': result.epsg,
		'seconds': result.seconds,
		'versions': VERSIONS,
		'failed_calls': sum(len(r.failures) for r in result.tiles),
		'coverage': {
			'mode': 'sampled',
			'tiles_total': result.tiles_total,
			'candidates': result.candidates,
			'tiles': len(result.tiles),
			'exclude_set': sum('exclude' in r.tile.sets for r in result.tiles),
			'training_set': sum('training' in r.tile.sets for r in result.tiles),
		},
		'cost': result.cost,
		'tiles': [
			{
				'pixel_window': list(r.tile.pixel_window),
				'sets': list(r.tile.sets),
				'weight': r.tile.weight,
				'predicted': {'deadwood': r.tile.deadwood_share, 'forest_cover': r.tile.forest_share},
				'picker': PICKER,
			}
			for r in result.tiles
		],
	}


def tile_row(r: TileResult, footprint: dict) -> dict:
	"""The tile's window on the CLIP grid; footprint is its WGS84 GeoJSON polygon."""
	return {'pixel_window': list(r.tile.pixel_window), 'geometry': footprint, 'mpp': r.crop.mpp, 'size_px': CROP_PX}


def image_rows(r: TileResult, tile_index: int, run_id: int, dataset_id: int, label_ids: dict) -> list[tuple]:
	"""The three images the judges saw of one tile: (audit.images row, JPEG bytes) each."""
	rows = []
	for (kind, layer), image in zip(IMAGE_KINDS, judge_images(r.crop)):
		buf = io.BytesIO()
		image.save(buf, 'JPEG', quality=88)
		data = buf.getvalue()
		label_id = label_ids[layer] if layer else None
		row = {
			'tile_index': tile_index,
			'prediction_label_id': label_id,
			'kind': kind,
			'storage_path': image_path(dataset_id, run_id, r.tile.pixel_window, kind, label_id),
			'content_type': 'image/jpeg',
			'width': CROP_PX,
			'height': CROP_PX,
			'mpp': r.crop.mpp,
			'bytes': len(data),
			'sha256': hashlib.sha256(data).hexdigest(),
		}
		rows.append((row, data))
	return rows


def judgement_rows(r: TileResult, tile_index: int) -> list[dict]:
	"""Per judge of one tile, one row per prediction layer."""
	return [
		{
			'tile_index': tile_index,
			'layer': LAYER_NAMES[layer],
			'judge': a.judge,
			'verdict': answer.verdict if a.assessable else 'not_assessable',
			'likelihood': answer.major_likelihood,
			# every mode names a problem, so a high likelihood always means one
			'problems': answer.modes,
			'summary': answer.summary or None,
			'raw': {'assessable': a.assessable, 'verdict': answer.verdict, 'errors': answer.errors},
		}
		for a in r.answers
		for layer, answer in a.layers.items()
	]


def image_path(dataset_id: int, run_id: int, pixel_window, kind: str, label_id: int | None) -> str:
	"""Storage path relative to the storage server's data directory; one folder per run."""
	x0, y0 = pixel_window[:2]
	label = f'-{label_id}' if label_id else ''
	return f'audit/{CHECK_KEY}/{dataset_id}/run-{run_id}/tile-{x0}-{y0}/{kind}{label}.jpg'


def build(run_id: int, result: CheckResult, *, inputs: dict, label_ids: dict, footprints: dict) -> tuple[dict, list]:
	"""The run's p_result and its image files [(storage path, bytes)].

	inputs: what the run judged; label_ids: the check's layer -> prediction label id;
	footprints: CLIP tile id -> WGS84 GeoJSON polygon. Tiles are referred to by their
	1-based position in p_result.tiles."""
	tiles, images, judgements, files = [], [], [], []
	for index, r in enumerate(result.tiles, start=1):
		tiles.append(tile_row(r, footprints[r.tile.tile_id]))
		for row, data in image_rows(r, index, run_id, result.dataset_id, label_ids):
			images.append(row)
			files.append((row['storage_path'], data))
		judgements += judgement_rows(r, index)
	payload = {
		'inputs': inputs,
		'evidence': evidence(result),
		'tiles': tiles,
		'images': images,
		'dataset_judgements': [],
		'tile_judgements': judgements,
	}
	return payload, files
