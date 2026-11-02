"""Map a check result onto the audit schema tables (DT-1481, #793: audit.runs, audit.crops, ...).

Pure functions: they return the rows to insert; the worker owns the connection, the storage
upload and the run lifecycle. Layer names follow the base tables ('forest_cover'), and every
model answer becomes one append-only audit.assessments row per crop and layer.
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
# Where each row kind goes: client.schema(SCHEMA).table(TABLES[kind]).
SCHEMA = 'audit'
TABLES = {'run': 'runs', 'crop': 'crops', 'image': 'images', 'assessment': 'assessments'}


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
	"""One row per crop window with every set it belongs to; footprint(tile) -> WGS84 GeoJSON polygon.

	Picker details are kept per set in selection, so a later picker can append its set to the row.
	"""
	rows = []
	for r in result.crops:
		x0, y0, x1, y1 = r.tile.pixel_window
		common = {
			'predicted': {'deadwood': r.tile.deadwood_share, 'forest_cover': r.tile.forest_share},
			'stratum': list(r.tile.stratum),
		}
		rows.append(
			{
				'dataset_id': result.dataset_id,
				'ortho_sha256': ortho_sha256,
				'crop_sets': list(r.tile.sets),
				'selected_by': SELECTED_BY,
				'pixel_x0': x0,
				'pixel_y0': y0,
				'pixel_x1': x1,
				'pixel_y1': y1,
				'geometry': footprint(r.tile),
				'mpp': r.crop.mpp,
				'size_px': CROP_PX,
				'selection': {
					s: {**common, 'picker': SELECTED_BY, **({'weight': r.tile.weight} if s == 'training' else {})}
					for s in r.tile.sets
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
						'label_id': label_ids.get(layer),
						'verdict': answer.verdict,
						'major_likelihood': answer.major_likelihood,
						'modes': answer.modes,
						'details': {'errors': answer.errors, 'area_pct': answer.area_pct},
						'raw': None,
					}
				)
	return rows


def rule_rows(result: CheckResult, label_ids: dict) -> list[dict]:
	"""The dataset verdict per layer as rule rows (assessor_kind 'rule', dataset target).

	The rule is Python in this check (rule.py), versioned like a prompt; a new rule version is
	recomputed from the stored crop rows and written as new rows, no model calls needed.
	"""
	verdicts = {'bad': 'major', 'ok': 'ok', None: 'unsure'}
	return [
		{
			'check_key': CHECK_KEY,
			'dataset_id': result.dataset_id,
			'crop_id': None,
			'layer': LAYER_NAMES[layer],
			'label_id': label_ids.get(layer),
			'assessor_kind': 'rule',
			'model': 'pq-rule',
			'prompt_version': RULE_VERSION,
			'verdict': verdicts[v['verdict']],
			'major_likelihood': None,
			'modes': {},
			'details': v,
			'raw': None,
		}
		for layer, v in result.verdicts.items()
	]


def image_path(dataset_id: int, ortho_sha256: str, crop_id: int, kind: str, label_id: int | None) -> str:
	"""Storage path relative to the storage server's data directory."""
	label = f'-{label_id}' if label_id else ''
	return f'audit/{dataset_id}/{ortho_sha256[:16]}/crop-{crop_id}/{kind}{label}.jpg'


def write(client, run_id: int, result: CheckResult, *, ortho_sha256: str, label_ids: dict, footprint, put_image) -> dict:
	"""Store one finished run's crops, images, model rows and rule rows.

	client: a Supabase client of the audit worker; put_image(path, bytes) stores a file on the
	storage server. Crops are shared across runs of the same ortho: an existing window only
	gains new sets. The run's status and the current-run pointer stay with the worker.
	"""
	audit = client.schema(SCHEMA)
	known = {
		(r['pixel_x0'], r['pixel_y0'], r['pixel_x1'], r['pixel_y1']): r
		for r in audit.table(TABLES['crop'])
		.select('id, pixel_x0, pixel_y0, pixel_x1, pixel_y1, crop_sets, selection')
		.eq('dataset_id', result.dataset_id)
		.eq('ortho_sha256', ortho_sha256)
		.execute()
		.data
	}
	crop_ids = {}
	for row in crop_rows(result, ortho_sha256, footprint):
		tile_id = row.pop('_tile_id')
		key = (row['pixel_x0'], row['pixel_y0'], row['pixel_x1'], row['pixel_y1'])
		old = known.get(key)
		if old is None:
			crop_ids[tile_id] = audit.table(TABLES['crop']).insert(row).execute().data[0]['id']
			continue
		crop_ids[tile_id] = old['id']
		sets = sorted(set(old['crop_sets']) | set(row['crop_sets']))
		selection = {**row['selection'], **old['selection']}  # sets and selection only grow
		if sets != sorted(old['crop_sets']) or selection != old['selection']:
			audit.table(TABLES['crop']).update({'crop_sets': sets, 'selection': selection}).eq('id', old['id']).execute()
	for row in image_rows(result, label_ids):
		data, crop_id = row.pop('_data'), crop_ids[row.pop('_tile_id')]
		row.update(
			crop_id=crop_id,
			ortho_sha256=ortho_sha256,
			storage_path=image_path(result.dataset_id, ortho_sha256, crop_id, row['kind'], row['label_id']),
		)
		put_image(row['storage_path'], data)
		audit.table(TABLES['image']).upsert(
			row, on_conflict='dataset_id,ortho_sha256,crop_id,label_id,kind', ignore_duplicates=True
		).execute()
	rows = []
	for row in assessment_rows(result, label_ids):
		row['crop_id'] = crop_ids[row.pop('_tile_id')]
		rows.append({**row, 'run_id': run_id})
	rows += [{**row, 'run_id': run_id} for row in rule_rows(result, label_ids)]
	if rows:
		audit.table(TABLES['assessment']).insert(rows).execute()
	run = run_row(result, ortho_sha256, label_ids, {})
	audit.table(TABLES['run']).update({'evidence': run['evidence'], 'coverage': run['coverage']}).eq('id', run_id).execute()
	return {'crops': len(crop_ids), 'assessments': len(rows)}
