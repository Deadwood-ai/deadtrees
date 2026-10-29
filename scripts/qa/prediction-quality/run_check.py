"""Run prediction_quality_v1 on given datasets, read-only, and keep every result locally.

Until the audit check tables (DT-1481) and the subscription worker (DT-1482) exist, this is the
way to run the check end to end: inputs from production through the analyst role (read-only
transaction), the COG streamed over HTTPS, judges Luna (OpenAI Responses API key) and Haiku
(Claude Code login). Writes <out>/<dataset>/result.json and the crop images the judges saw.
Run under a memory cap on the processing server (production ODM shares it):

  systemd-run --user --scope -p MemoryMax=4G -- python scripts/qa/prediction-quality/run_check.py ...
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

import psycopg
from psycopg.rows import dict_row
from shapely.geometry import shape

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from processor.src.prediction_quality_v1.check import run_prediction_quality  # noqa: E402
from processor.src.prediction_quality_v1.render import judge_images  # noqa: E402
from processor.src.prediction_quality_v1.tiles import Tile  # noqa: E402

COG_ROOT = 'https://data2.deadtrees.earth/cogs/v1/'
INPUTS_SQL = """
WITH pref AS (
  SELECT DISTINCT ON (l.label_data) l.label_data::text AS layer, l.id
  FROM v2_labels l
  WHERE l.dataset_id = %(id)s AND l.is_active AND l.label_source = 'model_prediction'
    AND l.label_data IN ('deadwood', 'forest_cover')
    AND EXISTS (SELECT 1 FROM v2_model_preferences p WHERE p.label_data = l.label_data::text AND l.model_config @> p.model_config)
  ORDER BY l.label_data, l.id DESC)
SELECT c.cog_path, (SELECT id FROM pref WHERE layer = 'deadwood') AS deadwood_label_id,
  (SELECT id FROM pref WHERE layer = 'forest_cover') AS forest_label_id,
  (SELECT ST_AsGeoJSON(ST_GeomFromGeoJSON(COALESCE(geometry->'geometry', geometry)))::jsonb FROM v2_aois
   WHERE dataset_id = %(id)s ORDER BY created_at DESC, id DESC LIMIT 1) AS aoi,
  (SELECT ST_Area(ST_GeomFromGeoJSON(COALESCE(geometry->'geometry', geometry))::geography) / 1e4 FROM v2_aois
   WHERE dataset_id = %(id)s ORDER BY created_at DESC, id DESC LIMIT 1) AS hectares
FROM v2_cogs c WHERE c.dataset_id = %(id)s
"""


def analyst():
	conn = psycopg.connect(os.environ['DEADTREES_ANALYST_DATABASE_URL'], row_factory=dict_row)
	conn.execute('SET TRANSACTION READ ONLY')
	return conn


def inputs(db, dataset_id):
	row = db.execute(INPUTS_SQL, {'id': dataset_id}).fetchone()
	tiles = [
		Tile(
			tile_id=r['id'],
			pixel_window=(r['pixel_x0'], r['pixel_y0'], r['pixel_x1'], r['pixel_y1']),
			bbox_4326=(r['x0'], r['y0'], r['x1'], r['y1']),
		)
		for r in db.execute(
			'SELECT id, pixel_x0, pixel_y0, pixel_x1, pixel_y1, ST_XMin(geometry) x0, ST_YMin(geometry) y0, '
			'ST_XMax(geometry) x1, ST_YMax(geometry) y1 FROM v2_tile_embeddings WHERE dataset_id = %s',
			(dataset_id,),
		).fetchall()
	]
	geoms = {}
	for layer, table, key in (
		('deadwood', 'v2_deadwood_geometries', 'deadwood_label_id'),
		('forest', 'v2_forest_cover_geometries', 'forest_label_id'),
	):
		geoms[layer] = [
			shape(r['g'])
			for r in db.execute(
				f'SELECT ST_AsGeoJSON(geometry)::jsonb AS g FROM {table} WHERE label_id = %s AND NOT is_deleted',
				(row[key],),
			).fetchall()
		] if row[key] else []
	return row, tiles, geoms


def jpeg_bytes(image, quality=90):
	buf = io.BytesIO()
	image.convert('RGB').save(buf, 'JPEG', quality=quality)
	return buf.getvalue()


def luna_backend(key, effort='medium'):
	def call(prompt, images):
		content = [{'type': 'input_text', 'text': prompt}] + [
			{
				'type': 'input_image',
				'image_url': 'data:image/jpeg;base64,' + base64.b64encode(jpeg_bytes(im, 85)).decode(),
				'detail': 'original',
			}
			for im in images
		]
		payload = {'model': 'gpt-6-luna', 'input': [{'role': 'user', 'content': content}], 'reasoning': {'effort': effort}}
		for attempt in range(4):
			try:
				req = Request(
					'https://api.openai.com/v1/responses', data=json.dumps(payload).encode(), method='POST',
					headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key},
				)
				with urlopen(req, timeout=300) as r:
					raw = json.loads(r.read(2_000_001))
				return ''.join(
					c.get('text', '') for item in raw.get('output', []) if item.get('type') == 'message'
					for c in item.get('content', [])
				)
			except HTTPError as e:
				if e.code not in (429, 500, 502, 503, 504) or attempt == 3:
					raise RuntimeError(f'Luna HTTP {e.code}') from None
				time.sleep(10 * (attempt + 1))

	return call


def haiku_backend(model='claude-haiku-5-5'):
	def call(prompt, images):
		with tempfile.TemporaryDirectory(prefix='pq-haiku-') as d:
			for i, im in enumerate(images):
				Path(d, f'image{i + 1}.jpg').write_bytes(jpeg_bytes(im))
			cmd = [
				'claude', '-p', '--model', model, '--output-format', 'json', '--tools', 'Read', '--allowedTools', 'Read',
				'--setting-sources', '', '--strict-mcp-config', '--system-prompt',
				'You assess aerial image predictions. Use the Read tool only to view the three image files named in '
				'the request, then answer with the requested JSON only.',
				'Read image1.jpg, image2.jpg and image3.jpg in this folder; they are Image 1, Image 2 and Image 3.\n\n'
				+ prompt,
			]
			done = subprocess.run(cmd, cwd=d, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=600)
			result = json.loads(done.stdout)  # stdout only: newer model names warn on stderr
			if done.returncode or result.get('is_error'):
				raise RuntimeError(f"Haiku failed: {str(result.get('result'))[:200]}")
			return result['result']

	return call


def read_key(path):
	for line in Path(path).expanduser().read_text().splitlines():
		if line.startswith('OPENAI_API_KEY='):
			return line.split('=', 1)[1].strip().strip('"\'')
	raise SystemExit('no OPENAI_API_KEY in key file')


def save(out, result, label_ids):
	out.mkdir(parents=True, exist_ok=True)
	crops = []
	for n, r in enumerate(result.crops, 1):
		folder = out / f'crop-{r.tile.tile_id}'
		folder.mkdir(exist_ok=True)
		for name, im in zip(('raw', 'deadwood', 'forest'), judge_images(r.crop)):
			im.save(folder / f'{name}.jpg', quality=88)
		crops.append(
			{
				'tile_id': r.tile.tile_id,
				'pixel_window': r.tile.pixel_window,
				'square_utm': r.tile.square_utm,
				'sets': r.tile.sets,
				'weight': r.tile.weight,
				'predicted': {'deadwood': r.tile.deadwood_share, 'forest': r.tile.forest_share},
				'answers': [
					{
						'judge': a.judge,
						'assessable': a.assessable,
						'layers': {
							k: {'verdict': v.verdict, 'major_likelihood': v.major_likelihood, 'modes': v.modes, 'errors': v.errors}
							for k, v in a.layers.items()
						},
					}
					for a in r.answers
				],
				'failures': r.failures,
				'combined': r.combined,
			}
		)
	(out / 'result.json').write_text(
		json.dumps(
			{
				'dataset_id': result.dataset_id,
				'epsg': result.epsg,
				'versions': result.versions,
				'label_ids': label_ids,
				'tiles_total': result.tiles_total,
				'seconds': result.seconds,
				'verdicts': result.verdicts,
				'crops': crops,
			},
			indent=1,
		)
	)


if __name__ == '__main__':
	p = argparse.ArgumentParser(description=__doc__)
	p.add_argument('--datasets', type=int, nargs='+', required=True)
	p.add_argument('--out', type=Path, required=True)
	p.add_argument('--key-file', type=Path, default=Path('~/.config/deadtrees/openai.env'))
	p.add_argument('--judges', nargs='+', default=['luna', 'haiku'], choices=['luna', 'haiku'])
	p.add_argument('--workers', type=int, default=6)
	a = p.parse_args()
	backends = {}
	if 'luna' in a.judges:
		backends['luna-medium'] = luna_backend(read_key(a.key_file))
	if 'haiku' in a.judges:
		backends['haiku-5.5'] = haiku_backend()
	for dataset_id in a.datasets:
		out = a.out / str(dataset_id)
		if (out / 'result.json').exists():
			continue
		with analyst() as db:
			row, tiles, geoms = inputs(db, dataset_id)
		if not row or not row['aoi'] or not tiles:
			print({'dataset': dataset_id, 'skipped': 'no COG, AOI or CLIP tiles'}, flush=True)
			continue
		result = run_prediction_quality(
			dataset_id,
			COG_ROOT + quote(row['cog_path'], safe='/'),
			tiles,
			shape(row['aoi']),
			geoms['deadwood'],
			geoms['forest'],
			row['hectares'],
			backends,
			workers=a.workers,
		)
		save(out, result, {'deadwood': row['deadwood_label_id'], 'forest': row['forest_label_id']})
		print(
			{
				'dataset': dataset_id,
				'crops': len(result.crops),
				'tiles': result.tiles_total,
				'seconds': result.seconds,
				'verdicts': {k: v['verdict'] for k, v in result.verdicts.items()},
				'failures': sum(len(r.failures) for r in result.crops),
			},
			flush=True,
		)
