#!/usr/bin/env python3
"""Seed one local dataset with automated audit check results for the Audit Review page
(docs/qa/playbooks/auditor-check-review.md): a georeferencing check that needs review
(one qualified reference, 19.8 m) with match lines, a dataset evaluation the deciding model
could not tell (Luna excludes; COG issue) with four tiles, and prediction quality on ten tiles
where the judges disagree on one deadwood tile, with stored tile images and one answer of
another reviewer. The runs are stored through audit.finish_run, as the audit worker does.

Local stack only: it refuses a database that is not on 127.0.0.1 or localhost.
Usage, after scripts/qa/env.sh up and reset:
	set -a; source .local/supabase/current.env; set +a
	python3 scripts/qa/seed-audit-checks.py [source-ortho.tif]
The source defaults to assets/test_data/test-data.tif (setup-worktree.sh without
--skip-assets). It (re)creates dataset 91090, which the QA reset removes.
"""

import hashlib
import json
import os
import subprocess
import sys
from urllib.parse import urlparse

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB = os.environ['SUPABASE_DB_URL']
DATA = os.environ['LOCAL_DATA_ROOT']
SOURCE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, 'assets/test_data/test-data.tif')
if urlparse(DB).hostname not in ('127.0.0.1', 'localhost'):
	sys.exit(f'Refusing a non-local database: {urlparse(DB).hostname}')

OWNER = '00000000-0000-4000-8000-00000000a001'  # the QA contributor; also the "other reviewer"
COG = os.path.join(DATA, 'cogs/qa-audit-review/review.tif')
PX = 4096
if not os.path.exists(COG):
	os.makedirs(os.path.dirname(COG), exist_ok=True)
	subprocess.run(['gdal_translate', '-q', '-of', 'COG', '-srcwin', '4000', '6000', str(PX), str(PX), SOURCE, COG], check=True)
SHA = hashlib.sha256(open(COG, 'rb').read()).hexdigest()
# what the page reads its image facts from (the shape rio-cogeo reports)
ORTHO_INFO = json.dumps(
	{
		'COG': True,
		'COG_errors': None,
		'COG_warnings': None,
		'Compression': 'DEFLATE',
		'GEO': {'CRS': 'PROJCS["WGS 84 / UTM zone 32N",GEOGCS["WGS 84"]]', 'Resolution': [0.05, -0.05]},
		'Profile': {'Bands': 3, 'Dtype': 'uint8', 'Tiled': True, 'Width': PX, 'Height': PX, 'ColorInterp': ['red', 'green', 'blue']},
	}
)
INFO = json.loads(subprocess.run(['gdalinfo', '-json', COG], check=True, capture_output=True, text=True).stdout)
X0, PIXEL, _, Y1 = INFO['geoTransform'][:4]
SIZE_M = PX * PIXEL
SRID = int(INFO['stac']['proj:epsg'])
LON0, LAT0 = INFO['wgs84Extent']['coordinates'][0][0]


def psql(sql: str) -> str:
	env = {**os.environ, 'PGGSSENCMODE': 'disable'}
	out = subprocess.run(['psql', DB, '-v', 'ON_ERROR_STOP=1', '-Atq', '-c', sql], env=env, capture_output=True, text=True)
	if out.returncode:
		sys.exit(out.stderr + sql)
	return out.stdout.strip()


def envelope_sql(x0, y0, x1, y1):
	return f"st_transform(st_makeenvelope({x0},{y0},{x1},{y1},{SRID}),4326)"


def jpeg(path, col, row, size, bands=(1, 2, 3)):
	os.makedirs(os.path.dirname(path), exist_ok=True)
	args = ['gdal_translate', '-q', '-of', 'JPEG', '-srcwin', str(col), str(row), str(size), str(size), '-outsize', '512', '512']
	for b in bands:
		args += ['-b', str(b)]
	subprocess.run(args + [COG, path], check=True)


# A fixed id in the QA fixture range, so scripts/qa/env.sh reset removes it with the rest.
ds = 91090
psql(f"delete from public.v2_datasets where id = {ds}")  # cascades to its checks
psql(f"""
insert into public.v2_datasets (id, file_name, user_id, license, platform, authors, data_access, aquisition_year, aquisition_month, aquisition_day)
values ({ds}, 'qa-audit-review.tif', '{OWNER}', 'CC BY', 'drone', array['QA audit review'], 'public', 2020, 7, 31)""")
psql(f"""
insert into public.v2_statuses (dataset_id, current_status, is_upload_done, is_ortho_done, is_cog_done, is_thumbnail_done,
	is_deadwood_done, is_forest_cover_done, is_metadata_done, is_combined_model_done, has_error)
values ({ds}, 'idle', true, true, true, true, true, true, true, true, false);
insert into public.v2_cogs (dataset_id, cog_file_name, version, cog_file_size, cog_info, cog_processing_runtime, cog_path)
values ({ds}, 'review.tif', 1, {os.path.getsize(COG)}, '{{}}', 0.1, 'qa-audit-review/review.tif');
insert into public.v2_orthos (dataset_id, ortho_file_name, version, ortho_file_size, sha256, bbox, ortho_info)
values ({ds}, 'review.tif', 1, {os.path.getsize(COG)}, '{SHA}', box2d({envelope_sql(X0, Y1 - SIZE_M, X0 + SIZE_M, Y1)}), '{ORTHO_INFO}');
""")

# --- georeferencing: a poor call decided by Bing alone, with match lines ---------------
lon0, lat0 = LON0 + 0.0002, LAT0 - 0.0002
pairs = [[lon0 + i * 0.00012, lat0 - j * 0.0001, lon0 + i * 0.00012 + 0.0002, lat0 - j * 0.0001 - 0.00008, 1] for i in range(5) for j in range(4)]
pairs += [[lon0 + 0.0003, lat0 - 0.0004, lon0 + 0.0004, lat0 - 0.00035, 0]]
evidence = [
	{'provider': 'bing', 'group': 'bing', 'matches': 60, 'inliers': 52, 'inlier_fraction': 0.87, 'cells': 14, 'support': 0.9,
	 'edge_support': 0.8, 'p50_m': 17.2, 'p90_m': 19.8, 'holdout_p90_m': [19.5, 20.1], 'vote': 'poor', 'qualified': True,
	 'decides': True, 'reason': None, 'sample_pairs': pairs},
	{'provider': 'esri', 'group': 'esri', 'matches': 4, 'inliers': 2, 'inlier_fraction': 0.5, 'cells': 1, 'support': 0.1,
	 'edge_support': 0.1, 'p50_m': None, 'p90_m': None, 'holdout_p90_m': [], 'vote': None, 'qualified': False,
	 'decides': False, 'reason': 'too_few_matches', 'sample_pairs': []},
]
metadata = {'references': {
	'bing': {'group': 'bing', 'zoom': 19, 'capture_date': None,
	         'viewer': {'kind': 'xyz', 'url': 'https://ecn.t0.tiles.virtualearth.net/tiles/a{q}.jpeg?g=1', 'max_zoom': 19, 'attribution': 'Microsoft Bing'}},
	'esri': {'group': 'esri', 'zoom': 19, 'capture_date': None,
	         'viewer': {'kind': 'xyz', 'url': 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', 'max_zoom': 19, 'attribution': 'Esri'}},
}}
psql(f"""
insert into public.v2_georef_checks (dataset_id, model_version, rules_version, decision, evidence_level, reason, p90_m,
	evidence_groups, support, edge_support, used_aoi, reference_evidence, reference_errors, metadata)
values ({ds}, 'romav2.0.1', 'georef-rules-v2', 'poor', 'qualified', 'single_reference', 19.8, 1, 0.9, 0.8, false,
	'{json.dumps(evidence)}', '{{"dop_bw": "too_few_matches"}}', '{json.dumps(metadata)}')""")

# --- check versions, with their rules, and runs ----------------------------------------
def version(check, name, rules, config=None):
	"""The check's active version and rules; a stack seeded with an older version name switches over."""
	conf = json.dumps(config or {})
	psql(f"update audit.check_versions set is_active = false where check_key = '{check}' and version <> '{name}' and is_active")
	vid = int(psql(f"""insert into audit.check_versions (check_key, version, config, is_active, activated_at)
		values ('{check}', '{name}', '{conf}', true, now())
		on conflict (check_key, version) do update set is_active = true returning id"""))
	psql(f"""insert into audit.check_rules (version_id, name, config, is_active, activated_at)
		values ({vid}, 'rules-v1', '{json.dumps(rules)}', true, now())
		on conflict (version_id, name) do update set is_active = true""")
	return vid


def run(check, vid):
	return int(psql(f"""insert into audit.runs (check_key, version_id, dataset_id, queue, status, started_at)
		values ('{check}', {vid}, {ds}, 'upload', 'running', now()) returning id"""))


def finish(rid, result):
	psql(f"select audit.finish_run({rid}, '{json.dumps(result).replace(chr(39), chr(39) * 2)}'::jsonb)")


def tile(col, row, size):
	x0 = X0 + col * SIZE_M / PX
	y1 = Y1 - row * SIZE_M / PX
	x1, y0 = x0 + size * SIZE_M / PX, y1 - size * SIZE_M / PX
	geometry = json.loads(psql(f"select st_asgeojson({envelope_sql(x0, y0, x1, y1)})"))
	return {'pixel_window': [col, row, col + size, row + size], 'geometry': geometry, 'mpp': 0.05, 'size_px': 1024}


def image(check, rid, kind, col, row, size, tile_index=None, label_id=None, bands=(1, 2, 3)):
	folder = f"audit/{check}/{ds}/run-{rid}/" + (f"tile-{col}-{row}/" if tile_index else '')
	rel = folder + f"{kind}{'-' + str(label_id) if label_id else ''}.jpg"
	jpeg(os.path.join(DATA, rel), col, row, size, bands)
	return {'tile_index': tile_index, 'prediction_label_id': label_id, 'kind': kind, 'storage_path': rel,
	        'content_type': 'image/jpeg', 'width': 512, 'height': 512}


# --- dataset evaluation: Haiku cannot tell (unsure), a COG issue, four native tiles -----
ev_vid = version('dataset_evaluation', 'v3-qa', {'decider': 'haiku', 'band_major_at': 90})
ev = run('dataset_evaluation', ev_vid)
spots = [(600, 700), (2600, 500), (900, 2700), (2900, 2900)]
flags = {'cog_issue': 80, 'thumbnail_issue': 10, 'reprocess': 70, 'blurry': 5}
finish(ev, {
	'inputs': {'ortho_sha256': SHA},
	'evidence': {'empty': False, 'band_check': {'likelihood': 0, 'findings': []}, 'coverage': {'tiles': 4, 'tile_picker': 'kmeans-inside-v1'}},
	'tiles': [tile(c, r, 512) for c, r in spots],
	'images': [image('dataset_evaluation', ev, 'overview', 0, 0, PX)]
	+ [image('dataset_evaluation', ev, 'raw', c, r, 512, n) for n, (c, r) in enumerate(spots, start=1)],
	'dataset_judgements': [
		{'judge': 'luna-medium', 'verdict': 'major', 'likelihood': 70, 'cog_issue': True, 'thumbnail_issue': False,
		 'exclude_reason': 'artifacts', 'summary': 'RGB forest scene, sharp; black edge band in the COG', 'raw': {'flags': flags}},
		{'judge': 'haiku-5.5', 'verdict': 'not_assessable', 'likelihood': 20, 'cog_issue': True, 'thumbnail_issue': False,
		 'exclude_reason': None, 'summary': 'Sharp RGB forest image with a COG edge artifact', 'raw': {'flags': flags}},
	],
})

# --- prediction quality: deadwood major on tiles 3 and 4; on tile 8 Luna says major, Haiku decides ok ---
pq = run('prediction_quality', version('prediction_quality', 'pq-v2-qa', {'decider': 'haiku'}))
DW, FC = 9001, 9002
major = {3, 4, 8}
tiles, images, judgements = [], [], []
for n in range(1, 11):
	c, r = 300 + ((n - 1) % 5) * 720, 900 + ((n - 1) // 5) * 1400
	tiles.append(tile(c, r, 640))
	images.append(image('prediction_quality', pq, 'raw', c, r, 640, n))
	images.append(image('prediction_quality', pq, 'deadwood_overlay', c, r, 640, n, DW, (1, 1, 3)))
	images.append(image('prediction_quality', pq, 'forest_cover_overlay', c, r, 640, n, FC, (2, 2, 2)))
	for judge in ('luna-medium', 'haiku-5.5'):
		disagrees = n == 8 and judge == 'haiku-5.5'
		# what the model saw: error types with their share of the tile, and its own words
		bad = n in major and not disagrees
		judgements.append({
			'tile_index': n, 'layer': 'deadwood', 'judge': judge, 'verdict': 'major' if bad else 'ok',
			'likelihood': 90 if bad else 20 if disagrees else 5,
			'problems': {'m1_dead_missed': {'likelihood': 90, 'area_pct': 12}, 'm4_dw_on_lying_wood': {'likelihood': 60, 'area_pct': 3}} if bad else {},
			'summary': None, 'raw': {'errors': ['Several dead crowns in the upper half are not marked blue.'] if bad else []},
		})
		judgements.append({
			'tile_index': n, 'layer': 'forest_cover', 'judge': judge, 'verdict': 'minor' if n == 7 else 'ok',
			'likelihood': 30 if n == 7 else 5, 'problems': {}, 'summary': None, 'raw': {'errors': []},
		})
finish(pq, {
	'inputs': {'ortho_sha256': SHA, 'aoi': None, 'label_ids': {'deadwood': DW, 'forest_cover': FC}},
	'evidence': {'coverage': {'mode': 'sampled', 'tiles_total': 10, 'tiles': 10, 'exclude_set': 10, 'training_set': 0}},
	'tiles': tiles,
	'images': images,
	'tile_judgements': judgements,
})

# another reviewer already answered georef: not passed
psql(f"""insert into audit.dataset_human_reviews (dataset_id, check_key, georef_status, reviewed_by)
	values ({ds}, 'georef', 'not_passed', '{OWNER}')""")
print(ds)
