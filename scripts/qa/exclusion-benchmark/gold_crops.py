"""Build the gold crop set: diverse 51.2 m crops at about 5 cm from many public datasets.

Datasets: public, unarchived, audited by a person and in season, with current preferred
deadwood and forest predictions, not used in the exclusion benchmark. Chosen by spread in
the scene-embedding space, half with a Bad audit. One crop per dataset, centred on a
predicted deadwood polygon (40%), a forest polygon (30%) or a random point (30%).
Read-only analyst SELECTs and public COG reads; writes only below --output.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
from urllib.parse import quote

import numpy as np
from PIL import Image
import rasterio
from rasterio.features import rasterize
from rasterio.warp import transform_bounds, transform_geom
from rasterio.windows import Window
from shapely.geometry import shape, box
from shapely.ops import transform as shape_transform

from analyst import analyst
from render_benchmark import COG_ROOT, COLORS, read, rgba
from select_benchmark import km

LAYERS = ('deadwood', 'forest_cover')
TABLES = {'deadwood': 'v2_deadwood_geometries', 'forest_cover': 'v2_forest_cover_geometries'}
CROP_M, OUT_PX = 51.2, 1024
POOL_SQL = """
WITH pref AS (
  SELECT DISTINCT ON (l.dataset_id, l.label_data) l.dataset_id, l.label_data::text AS layer, l.id
  FROM v2_labels l
  WHERE l.is_active AND l.label_source = 'model_prediction' AND l.label_data IN ('deadwood', 'forest_cover')
    AND EXISTS (SELECT 1 FROM v2_model_preferences p WHERE p.label_data = l.label_data::text AND l.model_config @> p.model_config)
  ORDER BY l.dataset_id, l.label_data, l.id DESC)
SELECT d.id AS dataset_id, d.platform::text AS platform, c.cog_path,
  a.deadwood_quality::text AS dq, a.forest_cover_quality::text AS fq,
  m.metadata->'biome'->>'biome_name' AS biome, m.metadata->'gadm'->>'admin_level_1' AS country,
  ST_X(ST_Centroid(ao.g)) AS lon, ST_Y(ST_Centroid(ao.g)) AS lat, ST_AsGeoJSON(ao.g)::jsonb AS aoi,
  dw.id AS deadwood_label_id, fc.id AS forest_cover_label_id
FROM dataset_audit a JOIN v2_datasets d ON d.id = a.dataset_id JOIN v2_cogs c ON c.dataset_id = d.id
JOIN pref dw ON dw.dataset_id = d.id AND dw.layer = 'deadwood'
JOIN pref fc ON fc.dataset_id = d.id AND fc.layer = 'forest_cover'
LEFT JOIN v2_metadata m ON m.dataset_id = d.id
LEFT JOIN LATERAL (SELECT ST_GeomFromGeoJSON(COALESCE(geometry->'geometry', geometry)) AS g FROM v2_aois
                   WHERE dataset_id = d.id ORDER BY created_at DESC, id DESC LIMIT 1) ao ON true
WHERE d.data_access = 'public' AND NOT d.archived AND a.audited_by IS NOT NULL AND a.has_valid_phenology IS TRUE
  AND a.deadwood_quality IS NOT NULL AND a.forest_cover_quality IS NOT NULL AND ao.g IS NOT NULL
"""


def select(rows, exclude, count):
    pool = [r for r in rows if r['dataset_id'] not in exclude and r['embedding'] is not None]
    chosen = []
    for want_bad in (True, False):
        group = [r for r in pool if (r['dq'] == 'bad' or r['fq'] == 'bad') == want_bad]
        picked = []
        while len(picked) < count // 2 and group:
            ref = chosen + picked
            cands = [r for r in group if r not in picked and all(km(r, s) > 10 for s in ref)]
            if not cands:
                break
            best = max(cands, key=lambda r: (1 - max((float(r['embedding'] @ s['embedding']) for s in ref), default=0),
                                             hashlib.sha256(str(r['dataset_id']).encode()).hexdigest()))
            picked.append(best)
        chosen += picked
    return chosen


def build(row, strategy, output, rng):
    directory = output / str(row['dataset_id'])
    if (directory / 'truth.json').exists():
        return json.loads((directory / 'truth.json').read_text())
    url = COG_ROOT + quote(row['cog_path'], safe='/')
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', GDAL_HTTP_TIMEOUT='60'), rasterio.open(url) as src:
        crs_m = 1 / math.cos(math.radians(row['lat'])) if src.crs.to_epsg() == 3857 else 1.0
        side_px = int(round(CROP_M * crs_m / abs(src.transform.a)))
        if side_px < 64 or src.crs.to_epsg() not in (3857, *range(32601, 32761)):
            raise ValueError('Unsupported COG grid')
        inv = ~src.transform
        aoi_px = shape_transform(lambda x, y: inv * (x, y), shape(transform_geom(4326, src.crs, row['aoi']))).buffer(0)
        def inside(cx, cy):
            w = box(cx - side_px / 2, cy - side_px / 2, cx + side_px / 2, cy + side_px / 2)
            ok = (0 <= w.bounds[0] and 0 <= w.bounds[1] and w.bounds[2] <= src.width and w.bounds[3] <= src.height
                  and w.intersection(aoi_px).area / w.area >= 0.9)
            return w if ok else None

        def to4326(w):
            left, top = src.transform * (w.bounds[0], w.bounds[1])
            right, bottom = src.transform * (w.bounds[2], w.bounds[3])
            return transform_bounds(src.crs, 4326, left, bottom, right, top)

        w = None
        with analyst() as db:
            if strategy in ('deadwood', 'forest_cover'):
                # Centre on a predicted polygon so there is something to judge nearby.
                centres = db.execute(f"SELECT ST_X(c) AS x, ST_Y(c) AS y FROM (SELECT ST_PointOnSurface(geometry) AS c "
                                     f"FROM {TABLES[strategy]} WHERE label_id = %s AND NOT is_deleted "
                                     "ORDER BY ST_Area(geometry) DESC LIMIT 200) q",
                                     (row[f'{strategy}_label_id'],)).fetchall()
                rng.shuffle(centres)
                for c in centres:
                    x, y = transform_geom(4326, src.crs, {'type': 'Point', 'coordinates': [c['x'], c['y']]})['coordinates']
                    col, r_ = inv * (x, y)
                    w = inside(col, r_)
                    if w is not None:
                        break
            if w is None:
                strategy = 'random' if strategy == 'random' else strategy + '_fallback_random'
                minx, miny, maxx, maxy = aoi_px.bounds
                for _ in range(400):
                    w = inside(rng.uniform(minx, maxx), rng.uniform(miny, maxy))
                    if w is not None:
                        break
            if w is None:
                raise ValueError('No crop fully inside the AOI')
            env = to4326(w)
            geoms = {l: [r['g'] for r in db.execute(
                f"SELECT ST_AsGeoJSON(geometry)::jsonb AS g FROM {TABLES[l]} WHERE label_id = %s AND NOT is_deleted "
                "AND ST_Intersects(geometry, ST_MakeEnvelope(%s,%s,%s,%s,4326))", (row[f'{l}_label_id'], *env)).fetchall()]
                for l in LAYERS}
        window = Window(int(w.bounds[0]), int(w.bounds[1]), side_px, side_px)
        rgb, valid, affine = read(src, window, OUT_PX)
        directory.mkdir(parents=True, exist_ok=True)
        Image.fromarray(rgb).save(directory / 'raw.jpg', quality=92)
        fractions = {}
        for l in LAYERS:
            shapes = [(transform_geom(4326, src.crs, g), 1) for g in geoms[l]]
            mask = (rasterize(shapes, out_shape=valid.shape, transform=affine, dtype='uint8') > 0
                    if shapes else np.zeros(valid.shape, bool)) & valid
            rgba(mask, COLORS[l], False).save(directory / f'{l}-fill.png')
            rgba(mask, COLORS[l], True).save(directory / f'{l}-outline.png')
            fractions[l] = float(mask.mean())
    truth = {'dataset_id': row['dataset_id'], 'strategy': strategy, 'mpp': CROP_M / rgb.shape[1],
             'size': [rgb.shape[1], rgb.shape[0]], 'predicted_fraction': fractions,
             'audit': {'deadwood': row['dq'], 'forest_cover': row['fq']}, 'biome': row['biome'],
             'country': row['country'], 'platform': row['platform']}
    (directory / 'truth.json').write_text(json.dumps(truth))
    return truth


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True, help='benchmark root (to exclude its datasets)')
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--count', type=int, default=120)
    a = p.parse_args()
    exclude = {d['dataset_id'] for d in json.loads((a.root / 'selection.json').read_text())['datasets']}
    exclude |= {c['dataset_id'] for c in json.loads((a.root / 'crop-test.json').read_text())}
    features = {r['dataset_id']: r['embedding'] for r in json.loads((a.root / 'audit-features.json').read_text())}
    with analyst() as db:
        rows = db.execute(POOL_SQL).fetchall()
    for r in rows:
        e = features.get(r['dataset_id'])
        r['embedding'] = (np.array(e) / np.linalg.norm(e)) if e else None
    chosen = select(rows, exclude, a.count)
    print({'pool': len(rows), 'chosen': len(chosen), 'bad': sum(r['dq'] == 'bad' or r['fq'] == 'bad' for r in chosen)}, flush=True)
    strategies = ('deadwood', 'forest_cover', 'random', 'deadwood', 'forest_cover', 'deadwood', 'random', 'forest_cover', 'deadwood', 'random')
    built = []
    for n, row in enumerate(chosen):
        rng = np.random.default_rng(row['dataset_id'])
        try:
            built.append(build(row, strategies[n % len(strategies)], a.output, rng))
        except Exception as e:
            print({'dataset': row['dataset_id'], 'error': f'{type(e).__name__}: {str(e)[:120]}'}, flush=True)
    print({'built': len(built)})
