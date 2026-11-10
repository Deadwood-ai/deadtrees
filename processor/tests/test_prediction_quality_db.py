"""Prediction quality rows against the real audit schema, as the audit worker's login.

The unit tests fake PostgREST; this one proves the tables take what store.write sends
(columns, geometry, the image upsert) and that the worker's policies allow it.
"""

from shapely.geometry import box, mapping

from processor.src.audit_worker import runs
from processor.src.audit_worker.__main__ import put_image_with
from processor.src.prediction_quality_v1 import judge, store, tiles
from processor.src.prediction_quality_v1.check import CheckResult, CropResult
from processor.src.prediction_quality_v1.render import render_crop
from processor.tests.test_prediction_quality import EPSG, X0, Y0, _answer, _ortho, _tile
from shared.db import use_client

SHA = 'd' * 64


def _result(dataset_id: int, sets: list[str]) -> CheckResult:
	square = (X0 + 5, Y0 + 5, X0 + 5 + tiles.TILE_M, Y0 + 5 + tiles.TILE_M)
	with _ortho().open() as src:
		crop = render_crop(src, EPSG, square, {'deadwood': [box(*square)], 'forest': []})
	tile = _tile(7, dw=0.1, fc=0.5)
	tile.sets, tile.weight = sets, 1.0 if 'training' in sets else None
	answers = [judge.parse('luna-medium', _answer(dw_major=80, verdict='major'))]
	verdicts = {'deadwood': {'rule': 'pq-rule-v1', 'verdict': 'bad', 'major_crops': 1, 'judged_crops': 1}}
	verdicts['forest'] = {'rule': 'pq-rule-v1', 'verdict': None, 'major_crops': 0, 'judged_crops': 0}
	return CheckResult(
		dataset_id=dataset_id,
		epsg=EPSG,
		crops=[CropResult(tile=tile, crop=crop, answers=answers)],
		verdicts=verdicts,
		tiles_total=1,
		seconds=1,
	)


def test_the_audit_tables_take_a_run_and_a_second_run_on_the_same_ortho(
	test_dataset_for_processing, auth_token, test_processor_user
):
	dataset_id = test_dataset_for_processing
	footprint = mapping(box(7.80, 48.00, 7.8007, 48.0005))
	with use_client(auth_token) as client:
		audit = client.schema('audit')
		version = runs.register_version(client, 'prediction_quality', 'v1-store-test', {})
		labels = {}
		for layer, data in (('deadwood', 'deadwood'), ('forest', 'forest_cover')):
			label = {
				'dataset_id': dataset_id,
				'user_id': test_processor_user,
				'label_source': 'model_prediction',
				'label_type': 'semantic_segmentation',
				'label_data': data,
				'label_quality': 3,
			}
			labels[layer] = client.table('v2_labels').insert(label).execute().data[0]['id']
		stored = []
		for sets in (['exclude'], ['exclude', 'training']):
			run = {'check_key': 'prediction_quality', 'check_version_id': version['id'], 'dataset_id': dataset_id}
			run_id = audit.table('runs').insert({**run, 'queue': 'manual'}).execute().data[0]['id']
			stored.append(
				store.write(
					client,
					run_id,
					_result(dataset_id, sets),
					ortho_sha256=SHA,
					label_ids=labels,
					footprint=lambda tile: footprint,
					put_image=put_image_with(lambda: auth_token),
				)
			)
		assert stored == [{'crops': 1, 'assessments': 5}] * 2
		crops = audit.table('crops').select('*').eq('dataset_id', dataset_id).execute().data
		assert len(crops) == 1 and crops[0]['crop_sets'] == ['exclude', 'training']
		assert set(crops[0]['selection']) == {'exclude', 'training'}
		images = audit.table('images').select('kind,label_id,storage_path').eq('dataset_id', dataset_id).execute().data
		assert sorted((i['kind'], i['label_id']) for i in images) == [
			('deadwood_overlay', labels['deadwood']),
			('forest_cover_overlay', labels['forest']),
			('raw', None),
		]
		assert all(i['storage_path'].startswith(f'audit/prediction_quality/{dataset_id}/') for i in images)
		rows = (
			audit.table('assessments').select('layer,assessor_kind,verdict').eq('dataset_id', dataset_id).execute().data
		)
		assert len(rows) == 10
		assert {(r['layer'], r['verdict']) for r in rows if r['assessor_kind'] == 'rule'} == {
			('deadwood', 'major'),
			('forest_cover', 'unsure'),
		}


def test_large_predictions_are_read_page_by_page(test_dataset_for_processing, auth_token, test_processor_user):
	count = 2500  # more than two pages
	from processor.src.prediction_quality_v1.handler import prediction_polygons

	with use_client(auth_token) as client:
		label = {
			'dataset_id': test_dataset_for_processing,
			'user_id': test_processor_user,
			'label_source': 'model_prediction',
			'label_type': 'semantic_segmentation',
			'label_data': 'deadwood',
			'label_quality': 3,
		}
		label_id = client.table('v2_labels').insert(label).execute().data[0]['id']
		polygon = mapping(box(7.80, 48.00, 7.8001, 48.0001))
		rows = [{'label_id': label_id, 'geometry': polygon} for _ in range(count)]
		for start in range(0, count, 500):
			client.table('v2_deadwood_geometries').insert(rows[start : start + 500]).execute()
		found = prediction_polygons(client, 'v2_deadwood_geometries', label_id)
	assert len(found) == count and found[0].geom_type == 'Polygon'
