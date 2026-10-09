"""Build a crop-level truth set from validated reference patches.

For each sampled public patch whose deadwood and forest references are both validated:
render raw RGB at the patch box from the public COG, rasterize the current preferred
predictions and the editor references, and store measured commission and omission per
layer. Read-only analyst SELECTs; outputs below --output only.
"""
import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
from urllib.parse import quote

import numpy as np
from PIL import Image
import rasterio
from rasterio.features import rasterize
from rasterio.warp import transform_bounds, transform_geom
from rasterio.windows import from_bounds

from analyst import analyst
from render_benchmark import COG_ROOT, COLORS, read, rgba

LAYERS = ('deadwood', 'forest_cover')
PRED_TABLE = {'deadwood': 'v2_deadwood_geometries', 'forest_cover': 'v2_forest_cover_geometries'}
REF_TABLE = {'deadwood': 'reference_patch_deadwood_geometries', 'forest_cover': 'reference_patch_forest_cover_geometries'}

PATCHES_SQL = """
SELECT p.id, p.dataset_id, p.resolution_cm, p.epsg_code, p.bbox_minx, p.bbox_miny, p.bbox_maxx, p.bbox_maxy,
       p.reference_deadwood_label_id, p.reference_forest_cover_label_id, c.cog_path,
       (SELECT l.id FROM v2_labels l WHERE l.dataset_id = p.dataset_id AND l.is_active AND l.label_source = 'model_prediction'
          AND l.label_data = 'deadwood' AND EXISTS (SELECT 1 FROM v2_model_preferences m WHERE m.label_data = 'deadwood'
          AND l.model_config @> m.model_config) ORDER BY l.id DESC LIMIT 1) AS pred_deadwood,
       (SELECT l.id FROM v2_labels l WHERE l.dataset_id = p.dataset_id AND l.is_active AND l.label_source = 'model_prediction'
          AND l.label_data = 'forest_cover' AND EXISTS (SELECT 1 FROM v2_model_preferences m WHERE m.label_data = 'forest_cover'
          AND l.model_config @> m.model_config) ORDER BY l.id DESC LIMIT 1) AS pred_forest_cover
FROM reference_patches p JOIN v2_datasets d ON d.id = p.dataset_id JOIN v2_cogs c ON c.dataset_id = d.id
WHERE p.deadwood_validated AND p.forest_cover_validated AND p.resolution_cm = 5
  AND d.data_access = 'public' AND NOT d.archived
"""


def sample(rows, per_dataset):
    groups = defaultdict(list)
    for r in rows:
        if r['pred_deadwood'] and r['pred_forest_cover']:
            groups[r['dataset_id']].append(r)
    out = []
    for g in groups.values():
        g.sort(key=lambda r: hashlib.sha256(f"patch-truth-v1:{r['id']}".encode()).hexdigest())
        out += g[:per_dataset]
    return out


def build(patch, output):
    directory = output / str(patch['id'])
    if (directory / 'truth.json').exists():
        return json.loads((directory / 'truth.json').read_text())
    crs = f"EPSG:{patch['epsg_code']}"
    box = (patch['bbox_minx'], patch['bbox_miny'], patch['bbox_maxx'], patch['bbox_maxy'])
    with analyst() as db:
        geoms = {}
        for layer in LAYERS:
            pred = db.execute(f"SELECT ST_AsGeoJSON(geometry)::jsonb AS g FROM {PRED_TABLE[layer]} WHERE label_id = %s "
                              "AND NOT is_deleted AND ST_Intersects(geometry, ST_Transform(ST_MakeEnvelope(%s,%s,%s,%s,%s),4326))",
                              (patch[f'pred_{layer}'], *box, patch['epsg_code'])).fetchall()
            # References are labels on the top-level base tile; its geometries are GeoJSON in EPSG:4326.
            label = db.execute("SELECT id FROM v2_labels WHERE reference_patch_id = %s AND label_data = %s AND is_active",
                               (patch['base_id'], layer)).fetchall()
            if len(label) != 1:
                raise ValueError('Missing or ambiguous reference label')
            ref = db.execute(f"SELECT geometry AS g FROM {REF_TABLE[layer]} WHERE label_id = %s", (label[0]['id'],)).fetchall()
            geoms[layer] = ([r['g'] for r in pred], [r['g'] for r in ref])
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', GDAL_HTTP_TIMEOUT='60'), \
            rasterio.open(COG_ROOT + quote(patch['cog_path'], safe='/')) as src:
        b = transform_bounds(crs, src.crs, *box)
        window = from_bounds(*b, src.transform).round_offsets().round_lengths()
        rgb, valid, affine = read(src, window, 1024)
        directory.mkdir(parents=True, exist_ok=True)
        Image.fromarray(rgb).save(directory / 'raw.jpg', quality=92)
        truth = {'patch_id': patch['id'], 'dataset_id': patch['dataset_id'], 'size': [rgb.shape[1], rgb.shape[0]],
                 'mpp': (box[2] - box[0]) / rgb.shape[1], 'valid_fraction': float(valid.mean()), 'layers': {}}
        for layer in LAYERS:
            masks = []
            for gs, srs in ((geoms[layer][0], 4326), (geoms[layer][1], 4326)):
                shapes = [(transform_geom(srs, src.crs, g), 1) for g in gs]
                masks.append((rasterize(shapes, out_shape=valid.shape, transform=affine, dtype='uint8') > 0
                              if shapes else np.zeros(valid.shape, bool)) & valid)
            pred, ref = masks
            rgba(pred, COLORS[layer], False).save(directory / f'{layer}-fill.png')
            rgba(pred, COLORS[layer], True).save(directory / f'{layer}-outline.png')
            truth['layers'][layer] = {'pred_px': int(pred.sum()), 'ref_px': int(ref.sum()),
                                      'commission': float((pred & ~ref).sum() / max(1, pred.sum())),
                                      'omission': float((ref & ~pred).sum() / max(1, ref.sum()))}
    (directory / 'truth.json').write_text(json.dumps(truth))
    return truth


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--per-dataset', type=int, default=8)
    p.add_argument('--workers', type=int, default=4)
    a = p.parse_args()
    with analyst() as db:
        rows = db.execute(PATCHES_SQL).fetchall()
        parents = {r['id']: r['parent_tile_id'] for r in db.execute('SELECT id, parent_tile_id FROM reference_patches').fetchall()}
    for r in rows:
        base = r['id']
        while parents.get(base):
            base = parents[base]
        r['base_id'] = base
    patches = sample(rows, a.per_dataset)
    print({'validated_public_5cm': len(rows), 'sampled': len(patches), 'datasets': len({r['dataset_id'] for r in patches})})
    done = failed = 0
    with ThreadPoolExecutor(a.workers) as pool:
        futures = {pool.submit(build, r, a.output): r['id'] for r in patches}
        for f in as_completed(futures):
            try:
                f.result(); done += 1
            except Exception as e:
                failed += 1
                print({'patch': futures[f], 'error': f'{type(e).__name__}: {str(e)[:120]}'}, flush=True)
    print({'built': done, 'failed': failed})
