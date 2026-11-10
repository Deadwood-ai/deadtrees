"""Map a check result onto the audit schema tables (audit.crops, audit.images, audit.assessments).

The row builders are pure; write() stores them for one run. The worker owns the connection, the
storage upload and the run lifecycle. Layer names follow the base tables ('forest_cover'), and
every model answer becomes one append-only audit.assessments row per crop and layer.
"""

from __future__ import annotations

import hashlib
import io

from shared.pagination import fetch_all_rows

from .check import VERSIONS, CheckResult, CropResult
from .judge import PROMPT_VERSION
from .render import CROP_PX, judge_images
from .rule import RULE_VERSION

CHECK_KEY = 'prediction_quality'
LAYER_NAMES = {'deadwood': 'deadwood', 'forest': 'forest_cover'}
IMAGE_KINDS = (('raw', None), ('deadwood_overlay', 'deadwood'), ('forest_cover_overlay', 'forest'))
SELECTED_BY = 'pq-picker-v1'
RULE_VERDICTS = {'bad': 'major', 'ok': 'ok', None: 'unsure'}


def summary(result: CheckResult) -> dict:
	"""What the worker finishes the run with."""
	return {
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
			'versions': VERSIONS,
			'failed_calls': sum(len(r.failures) for r in result.crops),
		},
		'cost': result.cost,
	}


def crop_row(r: CropResult, dataset_id: int, ortho_sha256: str, footprint: dict) -> dict:
	"""The crop window with every set it belongs to; footprint is the tile as WGS84 GeoJSON.

	Picker details are kept per set in selection, so a later picker can append its set to the row.
	"""
	x0, y0, x1, y1 = r.tile.pixel_window
	common = {
		'predicted': {'deadwood': r.tile.deadwood_share, 'forest_cover': r.tile.forest_share},
		'stratum': list(r.tile.stratum),
		'picker': SELECTED_BY,
	}
	return {
		'dataset_id': dataset_id,
		'ortho_sha256': ortho_sha256,
		'crop_sets': list(r.tile.sets),
		'pixel_x0': x0,
		'pixel_y0': y0,
		'pixel_x1': x1,
		'pixel_y1': y1,
		'geometry': footprint,
		'mpp': r.crop.mpp,
		'size_px': CROP_PX,
		'selection': {s: {**common, **({'weight': r.tile.weight} if s == 'training' else {})} for s in r.tile.sets},
	}


def image_rows(r: CropResult, crop_id: int, dataset_id: int, ortho_sha256: str, label_ids: dict) -> list[tuple]:
	"""The three images the judges saw of one crop: (audit.images row, JPEG bytes) each."""
	rows = []
	for (kind, layer), image in zip(IMAGE_KINDS, judge_images(r.crop)):
		buf = io.BytesIO()
		image.save(buf, 'JPEG', quality=88)
		data = buf.getvalue()
		sha256 = hashlib.sha256(data).hexdigest()
		label_id = label_ids[layer] if layer else None
		row = {
			'dataset_id': dataset_id,
			'ortho_sha256': ortho_sha256,
			'crop_id': crop_id,
			'label_id': label_id,
			'kind': kind,
			'storage_path': image_path(dataset_id, ortho_sha256, crop_id, kind, label_id, sha256),
			'content_type': 'image/jpeg',
			'width': CROP_PX,
			'height': CROP_PX,
			'mpp': r.crop.mpp,
			'bytes': len(data),
			'sha256': sha256,
		}
		rows.append((row, data))
	return rows


def assessment_rows(r: CropResult, crop_id: int, run_id: int, dataset_id: int, label_ids: dict) -> list[dict]:
	"""Per judge of one crop: one 'image' row (the m0 gate) and one row per prediction layer."""
	rows = []
	for a in r.answers:
		base = {
			'check_key': CHECK_KEY,
			'dataset_id': dataset_id,
			'run_id': run_id,
			'crop_id': crop_id,
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
				# Every mode names a problem, so a high likelihood always means one (base tables convention).
				'modes': {'m0_not_assessable': {'likelihood': 0 if a.assessable else 100}},
				'details': {},
				'raw': {'text': a.raw},
			}
		)
		for layer, answer in a.layers.items():
			rows.append(
				{
					**base,
					'layer': LAYER_NAMES[layer],
					'label_id': label_ids[layer],
					'verdict': answer.verdict,
					'major_likelihood': answer.major_likelihood,
					'modes': answer.modes,
					'details': {'errors': answer.errors, 'area_pct': answer.area_pct},
					'raw': None,
				}
			)
	return rows


def rule_rows(result: CheckResult, run_id: int, label_ids: dict) -> list[dict]:
	"""The dataset verdict per layer as rule rows (assessor_kind 'rule', dataset target).

	The rule is Python in this check (rule.py), versioned like a prompt; a new rule version is
	recomputed from the stored crop rows and written as new rows, no model calls needed.
	"""
	return [
		{
			'check_key': CHECK_KEY,
			'dataset_id': result.dataset_id,
			'run_id': run_id,
			'crop_id': None,
			'assessor_kind': 'rule',
			'model': 'pq-rule',
			'prompt_version': RULE_VERSION,
			'layer': LAYER_NAMES[layer],
			'label_id': label_ids[layer],
			'verdict': RULE_VERDICTS[v['verdict']],
			'major_likelihood': None,
			'modes': {},
			'details': v,
			'raw': None,
		}
		for layer, v in result.verdicts.items()
	]


def image_path(dataset_id: int, ortho_sha256: str, crop_id: int, kind: str, label_id: int | None, sha256: str) -> str:
	"""Storage path relative to the storage server's data directory. The name carries the
	content, so a later run on the same ortho never overwrites a file an earlier row points at."""
	label = f'-{label_id}' if label_id else ''
	return f'audit/{CHECK_KEY}/{dataset_id}/{ortho_sha256[:16]}/crop-{crop_id}/{kind}{label}-{sha256[:16]}.jpg'


def store_crops(audit, result: CheckResult, ortho_sha256: str, footprints: dict) -> dict:
	"""Tile id -> crop id. Crops are shared across checks and runs of the same ortho: an
	existing window only gains new sets."""
	known = {
		(r['pixel_x0'], r['pixel_y0'], r['pixel_x1'], r['pixel_y1']): r
		for r in fetch_all_rows(
			lambda: (
				audit.table('crops')
				.select('id, pixel_x0, pixel_y0, pixel_x1, pixel_y1, crop_sets, selection')
				.eq('dataset_id', result.dataset_id)
				.eq('ortho_sha256', ortho_sha256)
				.order('id')
			)
		)
	}
	crop_ids = {}
	for r in result.crops:
		row = crop_row(r, result.dataset_id, ortho_sha256, footprints[r.tile.tile_id])
		old = known.get(r.tile.pixel_window)
		if old is None:
			crop_ids[r.tile.tile_id] = audit.table('crops').insert(row).execute().data[0]['id']
			continue
		crop_ids[r.tile.tile_id] = old['id']
		sets = sorted(set(old['crop_sets']) | set(row['crop_sets']))
		selection = {**row['selection'], **old['selection']}  # sets and selection only grow
		if sets != sorted(old['crop_sets']) or selection != old['selection']:
			audit.table('crops').update({'crop_sets': sets, 'selection': selection}).eq('id', old['id']).execute()
	return crop_ids


def write(
	client, run_id: int, result: CheckResult, *, ortho_sha256: str, label_ids: dict, footprints: dict, put_image
) -> dict:
	"""Store one run's crops, images, model rows and rule rows.

	client: a Supabase client of the audit worker; footprints: tile id -> WGS84 GeoJSON polygon;
	put_image(path, bytes, dataset_id) stores a file on the storage server. Images are kept per
	crop and prediction: an image that is already stored is not uploaded again, and one that
	differs from the stored row (the AOI changed, so other parts are darkened) is uploaded and
	named in the answer, because the stored row stays the first; the review page shows the
	run's own file. The answer also names the run's crops with their sets and weights: the
	crop row holds the sets of every run on the ortho, so only the run can say which it
	judged as which. The assessments
	go last and in one insert, so an attempt that fails before that insert leaves nothing a
	retry would double. The run row itself (status, evidence, coverage, cost) is the worker's
	to finish.
	"""
	audit = client.schema('audit')
	crop_ids = store_crops(audit, result, ortho_sha256, footprints)
	shown = {
		(i['crop_id'], i['label_id'], i['kind']): i['sha256']
		for i in fetch_all_rows(
			lambda: (
				audit.table('images')
				.select('id, crop_id, label_id, kind, sha256')
				.eq('dataset_id', result.dataset_id)
				.eq('ortho_sha256', ortho_sha256)
				.order('id')
			)
		)
	}
	new, differing, assessments = [], [], []
	for r in result.crops:
		crop_id = crop_ids[r.tile.tile_id]
		for row, data in image_rows(r, crop_id, result.dataset_id, ortho_sha256, label_ids):
			key = (crop_id, row['label_id'], row['kind'])
			if shown.get(key) == row['sha256']:
				continue
			# Files first, rows second: a stored row always points at an uploaded image.
			put_image(row['storage_path'], data, result.dataset_id)
			(differing if key in shown else new).append(row)
		assessments += assessment_rows(r, crop_id, run_id, result.dataset_id, label_ids)
	if new:
		audit.table('images').upsert(
			new, on_conflict='dataset_id,ortho_sha256,crop_id,label_id,kind', ignore_duplicates=True
		).execute()
	assessments += rule_rows(result, run_id, label_ids)
	audit.table('assessments').insert(assessments).execute()
	return {
		'crops': len(crop_ids),
		'assessments': len(assessments),
		'judged': {
			'crop_ids': list(crop_ids.values()),
			'exclude': [crop_ids[r.tile.tile_id] for r in result.crops if 'exclude' in r.tile.sets],
			'training': {
				str(crop_ids[r.tile.tile_id]): r.tile.weight for r in result.crops if 'training' in r.tile.sets
			},
			# only the images that differ from the stored row: the review page shows these files instead
			'images': [
				{k: row[k] for k in ('crop_id', 'label_id', 'kind', 'storage_path', 'sha256')} for row in differing
			],
		},
	}
