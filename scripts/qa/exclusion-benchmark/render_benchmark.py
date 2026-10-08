"""Render dataset-level evidence for the exclusion benchmark: overview, 3x3 grid, native crops.

Reads public COGs over HTTP and prediction polygons with the analyst route. Writes
only below the output directory. Audit grades never enter the rendered evidence.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from urllib.parse import quote

import numpy as np
from PIL import Image
from pyproj import Geod, Transformer
import rasterio
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.warp import transform_bounds, transform_geom
from rasterio.windows import Window, transform as window_transform
from shapely.geometry import box, shape
from shapely.ops import transform as shape_transform

from analyst import analyst

LAYERS = ('deadwood', 'forest_cover')
TABLES = {'deadwood': 'v2_deadwood_geometries', 'forest_cover': 'v2_forest_cover_geometries'}
COLORS = {'deadwood': (30, 135, 255), 'forest_cover': (255, 202, 50)}
GEOD = Geod(ellps='WGS84')
COG_ROOT = 'https://data2.deadtrees.earth/cogs/v1/'
MAX_FEATURES = 60000


def save_json(path, value):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, indent=2, default=str) + '\n')
    tmp.replace(path)


def rgba(mask, color, outline):
    mask = mask.copy()
    if outline:
        inner = mask.copy()
        inner[1:] &= mask[:-1]
        inner[:-1] &= mask[1:]
        inner[:, 1:] &= mask[:, :-1]
        inner[:, :-1] &= mask[:, 1:]
        mask &= ~inner
    out = np.zeros((*mask.shape, 4), 'uint8')
    out[mask, :3] = color
    out[mask, 3] = 255
    return Image.fromarray(out)


def fetch(dataset):
    with analyst() as db:
        cog = db.execute("SELECT c.cog_path, c.version FROM v2_cogs c JOIN v2_datasets d ON d.id = c.dataset_id "
                         "WHERE c.dataset_id = %s AND d.data_access = 'public' AND NOT d.archived",
                         (dataset['dataset_id'],)).fetchone()
        if not cog:
            raise ValueError('Dataset is no longer public')
        aoi = db.execute("SELECT COALESCE(geometry->'geometry', geometry) AS g FROM v2_aois WHERE dataset_id = %s "
                         "ORDER BY created_at DESC, id DESC LIMIT 1", (dataset['dataset_id'],)).fetchone()['g']
        geometries = {}
        for layer in LAYERS:
            label_id = dataset[layer + '_label_id']
            active = db.execute('SELECT 1 FROM v2_labels WHERE id = %s AND is_active', (label_id,)).fetchone()
            if not active:
                raise ValueError(f'{layer} prediction changed since selection')
            # Keyset pages keep each statement under the analyst statement timeout.
            rows, last = [], 0
            while True:
                page = db.execute(f'SELECT id, ST_AsGeoJSON(geometry)::jsonb AS g FROM {TABLES[layer]} '
                                  'WHERE label_id = %s AND NOT is_deleted AND id > %s ORDER BY id LIMIT 2000',
                                  (label_id, last)).fetchall()
                rows += page
                if len(page) < 2000:
                    break
                last = page[-1]['id']
                if len(rows) > MAX_FEATURES:
                    raise ValueError(f'{layer} exceeds {MAX_FEATURES} polygons')
            geometries[layer] = [r['g'] for r in rows]
    return cog, aoi, geometries


def read(src, window, limit, resampling=Resampling.bilinear):
    factor = min(1, limit / max(window.width, window.height))
    w, h = max(1, round(window.width * factor)), max(1, round(window.height * factor))
    # Windows are clamped to the raster; boundless reads would bypass the COG overviews.
    rgb = src.read([1, 2, 3], window=window, out_shape=(3, h, w), resampling=resampling).transpose(1, 2, 0)
    valid = src.dataset_mask(window=window, out_shape=(h, w), resampling=Resampling.nearest) > 0
    affine = window_transform(window, src.transform) * rasterio.Affine.scale(window.width / w, window.height / h)
    return rgb, valid & rgb.any(axis=2), affine


def ground_mpp(src, affine, size):
    to_wgs = Transformer.from_crs(src.crs, 4326, always_xy=True)
    a, b = [to_wgs.transform(*(affine * (size[0] / 2 + i, size[1] / 2))) for i in (0, 1)]
    return abs(GEOD.inv(*a, *b)[2])


def render_view(src, name, window, limit, aoi_src, shapes, directory, pixels=None):
    rgb, valid, affine = pixels or read(src, window, limit)
    inside = rasterize([(aoi_src, 1)], out_shape=valid.shape, transform=affine, dtype='uint8') > 0
    support = valid & inside
    Image.fromarray(np.where(support[..., None], rgb, (rgb * 0.35).astype('uint8'))).save(
        directory / f'{name}-raw.jpg', quality=92, subsampling=0)
    view = {'name': name, 'size': [rgb.shape[1], rgb.shape[0]],
            'window': [int(window.col_off), int(window.row_off), int(window.width), int(window.height)],
            'mpp': ground_mpp(src, affine, (rgb.shape[1], rgb.shape[0])),
            'support_fraction': float(support.mean()), 'predicted_fraction': {}}
    for layer in LAYERS:
        mask = (rasterize([(g, 1) for g in shapes[layer]], out_shape=valid.shape, transform=affine, dtype='uint8') > 0
                if shapes[layer] else np.zeros(valid.shape, bool)) & support
        rgba(mask, COLORS[layer], False).save(directory / f'{name}-{layer}-fill.png')
        rgba(mask, COLORS[layer], True).save(directory / f'{name}-{layer}-outline.png')
        view['predicted_fraction'][layer] = float(mask.sum() / max(1, support.sum()))
    return view, support


def native_windows(src, aoi_pixels, overview_support, overview_window, count, seed):
    size = 1024
    w, h = min(size, src.width), min(size, src.height)
    sy, sx = overview_support.shape
    scale_x, scale_y = overview_window.width / sx, overview_window.height / sy
    rng = np.random.default_rng(seed)
    ys, xs = np.nonzero(overview_support)
    if len(xs) == 0:
        return []
    picks = rng.choice(len(xs), size=min(400, len(xs)), replace=False)
    candidates = []
    for i in picks:
        cx = overview_window.col_off + (xs[i] + .5) * scale_x
        cy = overview_window.row_off + (ys[i] + .5) * scale_y
        x = int(max(0, min(src.width - w, cx - w / 2)))
        y = int(max(0, min(src.height - h, cy - h / 2)))
        cell = box(x, y, x + w, y + h)
        if cell.intersection(aoi_pixels).area / cell.area >= .7:
            candidates.append((x, y))
    chosen = []
    while candidates and len(chosen) < count:
        best = max(candidates, key=lambda c: min(((c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 for p in chosen),
                                                 default=float(rng.random())))
        chosen.append(best)
        candidates.remove(best)
    return [Window(x, y, w, h) for x, y in chosen]


def render(dataset, output):
    directory = output / 'datasets' / str(dataset['dataset_id'])
    if (directory / 'evidence.json').exists():
        return json.loads((directory / 'evidence.json').read_text())
    directory.mkdir(parents=True, exist_ok=True)
    cog, aoi, geometries = fetch(dataset)
    url = COG_ROOT + quote(cog['cog_path'], safe='/')
    env = dict(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', GDAL_HTTP_TIMEOUT='60', GDAL_HTTP_MAX_RETRY='2',
               GDAL_CACHEMAX=128)
    with rasterio.Env(**env), rasterio.open(url) as src:
        if not src.crs or src.transform.b or src.transform.d:
            raise ValueError('Requires a north-up georeferenced COG')
        aoi_src = transform_geom(4326, src.crs, aoi)
        shapes = {layer: [transform_geom(4326, src.crs, g) for g in geometries[layer]] for layer in LAYERS}
        inv = ~src.transform
        aoi_pixels = shape_transform(lambda x, y: inv * (x, y), shape(aoi_src)).buffer(0)
        x0, y0, x1, y1 = aoi_pixels.bounds
        x0, y0 = max(0, int(x0)), max(0, int(y0))
        x1, y1 = min(src.width, int(np.ceil(x1))), min(src.height, int(np.ceil(y1)))
        overview_window = Window(x0, y0, x1 - x0, y1 - y0)
        # One read at grid resolution serves the overview and all nine grid cells.
        rgb, valid, affine = read(src, overview_window, 3072)
        small = Image.fromarray(rgb)
        factor = min(1, 2048 / max(rgb.shape[1], rgb.shape[0]))
        size = (max(1, round(rgb.shape[1] * factor)), max(1, round(rgb.shape[0] * factor)))
        overview_pixels = (np.asarray(small.resize(size, Image.BILINEAR)),
                           np.asarray(Image.fromarray(valid).resize(size, Image.NEAREST)),
                           affine * rasterio.Affine.scale(rgb.shape[1] / size[0], rgb.shape[0] / size[1]))
        overview, overview_support = render_view(src, 'overview', overview_window, 2048, aoi_src, shapes, directory,
                                                 overview_pixels)
        views = [overview]
        h, w = valid.shape
        for row in range(3):
            for col in range(3):
                ys, xs = slice(h * row // 3, h * (row + 1) // 3), slice(w * col // 3, w * (col + 1) // 3)
                cw, ch = overview_window.width / 3, overview_window.height / 3
                cell = Window(round(x0 + col * cw), round(y0 + row * ch), round(cw), round(ch))
                cell_box = box(cell.col_off, cell.row_off, cell.col_off + cell.width, cell.row_off + cell.height)
                if cell_box.intersection(aoi_pixels).area / cell_box.area < .05:
                    continue
                cell_affine = affine * rasterio.Affine.translation(xs.start, ys.start)
                view, _ = render_view(src, f'g{row * 3 + col + 1}', cell, 1024, aoi_src, shapes, directory,
                                      (rgb[ys, xs], valid[ys, xs], cell_affine))
                view['kind'] = 'grid'
                views.append(view)
        for i, window in enumerate(native_windows(src, aoi_pixels, overview_support, overview_window, 4,
                                                  dataset['dataset_id'])):
            view, _ = render_view(src, f'n{i + 1}', window, 1024, aoi_src, shapes, directory)
            view['kind'] = 'native'
            views.append(view)
        overview['kind'] = 'overview'
        evidence = {
            'dataset_id': dataset['dataset_id'], 'captured_at': datetime.now(timezone.utc).isoformat(),
            'cog': {'path': cog['cog_path'], 'version': cog['version'], 'size': [src.width, src.height]},
            'native_mpp': ground_mpp(src, src.transform, (2, 2)),
            'aoi_area_ha': abs(GEOD.geometry_area_perimeter(shape(aoi))[0]) / 1e4,
            'polygons': {layer: len(geometries[layer]) for layer in LAYERS},
            'label_ids': {layer: dataset[layer + '_label_id'] for layer in LAYERS},
            'views': views,
            'files': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(directory.glob('*.*'))
                      if p.suffix in ('.jpg', '.png')},
        }
    save_json(directory / 'evidence.json', evidence)
    return evidence


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--selection', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--workers', type=int, default=4)
    p.add_argument('--only', type=int, nargs='*')
    a = p.parse_args()
    datasets = json.loads(a.selection.read_text())['datasets']
    if a.only:
        datasets = [d for d in datasets if d['dataset_id'] in a.only]
    failures = []
    with ThreadPoolExecutor(max_workers=a.workers) as pool:
        futures = {pool.submit(render, d, a.output): d['dataset_id'] for d in datasets}
        for future in as_completed(futures):
            dataset_id = futures[future]
            try:
                evidence = future.result()
                print({'dataset': dataset_id, 'views': len(evidence['views'])}, flush=True)
            except Exception as e:
                failures.append({'dataset_id': dataset_id, 'error': f'{type(e).__name__}: {str(e)[:200]}'})
                print(failures[-1], flush=True)
    save_json(a.output / 'render-failures.json', failures)
