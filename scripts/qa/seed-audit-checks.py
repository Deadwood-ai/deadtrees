#!/usr/bin/env python3
"""Seed one local dataset with automated audit check results for the audit review page
(docs/qa/playbooks/auditor-check-review.md): a poor georeferencing call with match lines,
a dataset evaluation (keep, fix) with four crops, and prediction quality on ten crops,
with stored crop images and one answer of another reviewer.

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
insert into public.v2_orthos (dataset_id, ortho_file_name, version, ortho_file_size, sha256, bbox)
values ({ds}, 'review.tif', 1, {os.path.getsize(COG)}, '{SHA}', box2d({envelope_sql(X0, Y1 - SIZE_M, X0 + SIZE_M, Y1)}));
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
# The current-run pointer only follows an active version: register and activate it first.
psql("""
insert into audit.check_versions (check_key, version, config, is_active)
values ('georef', 'georef-rules-v2_romav2.0.1', '{"rules_version": "georef-rules-v2", "model_version": "romav2.0.1"}', true)
on conflict (check_key, version) do update set is_active = true""")
psql(f"""
insert into public.v2_georef_checks (dataset_id, model_version, rules_version, decision, evidence_level, reason, p90_m,
	evidence_groups, support, edge_support, used_aoi, reference_evidence, reference_errors, metadata)
values ({ds}, 'romav2.0.1', 'georef-rules-v2', 'poor', 'qualified', 'single_reference', 19.8, 1, 0.9, 0.8, false,
	'{json.dumps(evidence)}', '{{"dop_bw": "too_few_matches"}}', '{json.dumps(metadata)}');
select internal.store_georef_audit_run({ds}, 'upload');
""")

# --- check versions -------------------------------------------------------------------
def version(check, name):
	return int(psql(f"""insert into audit.check_versions (check_key, version, is_active) values ('{check}', '{name}', true)
		on conflict (check_key, version) do update set is_active = true returning id"""))


def run(check, vid):
	rid = int(psql(f"""insert into audit.runs (check_key, check_version_id, dataset_id, queue, status, inputs, started_at, finished_at)
		values ('{check}', {vid}, {ds}, 'upload', 'done', '{{"ortho_sha256": "{SHA}"}}', now(), now()) returning id"""))
	psql(f"insert into audit.current_runs (dataset_id, check_key, run_id) values ({ds}, '{check}', {rid})")
	return rid


def crop(sets, col, row, size):
	x0 = X0 + col * SIZE_M / PX
	y1 = Y1 - row * SIZE_M / PX
	x1, y0 = x0 + size * SIZE_M / PX, y1 - size * SIZE_M / PX
	return int(psql(f"""insert into audit.crops (dataset_id, ortho_sha256, crop_sets, pixel_x0, pixel_y0, pixel_x1, pixel_y1, geometry, mpp, size_px)
		values ({ds}, '{SHA}', array{sets}::text[], {col}, {row}, {col + size}, {row + size}, {envelope_sql(x0, y0, x1, y1)}, 0.05, 1024) returning id"""))


def image(crop_id, kind, col, row, size, label_id=None, bands=(1, 2, 3)):
	rel = f"audit/{ds}/{SHA[:16]}/" + (f"crop-{crop_id}/{kind}{'-' + str(label_id) if label_id else ''}.jpg" if crop_id else f"{kind}.jpg")
	jpeg(os.path.join(DATA, rel), col, row, size, bands)
	psql(f"""insert into audit.images (dataset_id, ortho_sha256, crop_id, label_id, kind, storage_path, content_type, width, height)
		values ({ds}, '{SHA}', {crop_id or 'null'}, {label_id or 'null'}, '{kind}', '{rel}', 'image/jpeg', 512, 512)""")


def assess(check, rid, layer, kind, model, verdict, crop_id=None, label_id=None, modes=None, details=None):
	psql(f"""insert into audit.assessments (check_key, dataset_id, crop_id, run_id, layer, label_id, assessor_kind, model, prompt_version, verdict, modes, details)
		values ('{check}', {ds}, {crop_id or 'null'}, {rid}, '{layer}', {label_id or 'null'}, '{kind}', '{model}', 'v1', '{verdict}',
		'{json.dumps(modes or {})}', '{json.dumps(details or {})}')""")


# --- dataset evaluation: keep, fix (COG issue), four native crops ---------------------
ev = run('dataset_evaluation', version('dataset_evaluation', 'v1-qa'))
image(None, 'overview', 0, 0, PX)
for i, (c, r) in enumerate([(600, 700), (2600, 500), (900, 2700), (2900, 2900)]):
	cid = crop(['evaluation'], c, r, 512)
	image(cid, 'raw', c, r, 512)
modes = {'cog_issue': {'likelihood': 80}, 'thumbnail_issue': {'likelihood': 10}, 'blurry': {'likelihood': 5}}
assess('dataset_evaluation', ev, 'image', 'rule', 'dataset-evaluation-rule', 'minor', modes=modes,
       details={'reason': None, 'why': ['fix_flagged'], 'models': {'luna': 'minor', 'haiku': 'minor'}})
assess('dataset_evaluation', ev, 'image', 'model', 'luna', 'minor', modes=modes, details={'summary': 'RGB forest scene, sharp; black edge band in the COG'})
assess('dataset_evaluation', ev, 'image', 'model', 'haiku', 'minor', modes=modes, details={'summary': 'Sharp RGB forest image with a COG edge artifact'})

# --- prediction quality: deadwood major on 3 of 10 crops ------------------------------
pq = run('prediction_quality', version('prediction_quality', 'pq-v1-qa'))
DW, FC = 9001, 9002
major = {3, 4, 8}
for n in range(10):
	c, r = 300 + (n % 5) * 720, 900 + (n // 5) * 1400
	cid = crop(['exclude'], c, r, 640)
	image(cid, 'raw', c, r, 640)
	image(cid, 'deadwood_overlay', c, r, 640, DW, (1, 1, 3))
	image(cid, 'forest_cover_overlay', c, r, 640, FC, (2, 2, 2))
	for judge in ('luna', 'haiku'):
		assess('prediction_quality', pq, 'image', 'model', judge, 'ok', crop_id=cid, modes={'m0_not_assessable': {'likelihood': 0}})
		assess('prediction_quality', pq, 'deadwood', 'model', judge, 'major' if n + 1 in major else 'ok', crop_id=cid, label_id=DW)
		assess('prediction_quality', pq, 'forest_cover', 'model', judge, 'minor' if n == 6 else 'ok', crop_id=cid, label_id=FC)
assess('prediction_quality', pq, 'deadwood', 'rule', 'pq-rule', 'major', label_id=DW,
       details={'rule': 'pq-rule-v1', 'verdict': 'bad', 'major_crops': 3, 'judged_crops': 10})
assess('prediction_quality', pq, 'forest_cover', 'rule', 'pq-rule', 'ok', label_id=FC,
       details={'rule': 'pq-rule-v1', 'verdict': 'ok', 'major_crops': 0, 'judged_crops': 10})

# another reviewer already answered georef (hidden until the auditor answers)
geo_run = psql(f"select run_id from audit.current_runs where dataset_id = {ds} and check_key = 'georef'")
psql(f"""insert into audit.assessments (check_key, dataset_id, run_id, layer, assessor_kind, assessor_user_id, verdict)
	values ('georef', {ds}, {geo_run}, 'georef', 'person', '{OWNER}', 'major')""")
print(ds)
