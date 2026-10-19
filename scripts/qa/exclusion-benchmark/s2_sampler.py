"""Crops that line up with Sentinel-2 pixels, sampled over the labels the satellite model learns.

Each crop is exactly 5 x 5 Sentinel-2 pixels (50 m), snapped to the 10 m UTM grid that
Sentinel-2 tiles use, so a crop verdict maps onto the training pixels it covers. Candidates
come from the stored CLIP tiles (spread over the dataset); for each candidate the predicted
deadwood and forest cover is rasterised from the prediction polygons. Crops are then drawn
per label stratum (deadwood 0 / <5% / 5-20% / >20% x forest 0 / partial / closed), with
square-root allocation so rare high-deadwood cells get more crops than their area share.
Each crop carries the weight of the area it stands for, so dataset shares stay unbiased.
Count: 1 crop per 2 ha, 10 to 40. Writes <output>/picks.json and the crops. Read-only SQL,
windowed COG reads (no boundless reads), run under a memory cap.
"""
import argparse
import json
import math
from pathlib import Path
from urllib.parse import quote

import numpy as np
from PIL import Image
import rasterio
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.transform import from_bounds
from rasterio.warp import reproject, transform_bounds, transform_geom
from rasterio.windows import from_bounds as window_from_bounds
from shapely.geometry import box, shape
from shapely.ops import transform as shp_transform
from pyproj import Transformer

from analyst import analyst
from crop_sampler import crop_count
from gold_crops import POOL_SQL, TABLES
from render_benchmark import COG_ROOT, COLORS, rgba

CELL = 50.0  # 5 x 5 Sentinel-2 pixels of 10 m
OUT_PX = 1000  # 5 cm per pixel
MAX_CANDIDATES = 600
DW_BINS, FC_BINS = (0, 0.05, 0.20), (0, 0.6)  # >0, >5%, >20% ; >0, >=60%


def utm_epsg(lon, lat):
    return (32600 if lat >= 0 else 32700) + int((lon + 180) // 6) + 1


def stratum(dw, fc):
    d = 0 if dw == 0 else 1 + sum(dw > b for b in DW_BINS[1:])
    f = 0 if fc == 0 else 1 + int(fc >= FC_BINS[1])
    return d, f


def candidates(db, row):
    tiles = db.execute(
        "SELECT ST_X(ST_Centroid(t.geometry)) AS lon, ST_Y(ST_Centroid(t.geometry)) AS lat FROM v2_tile_embeddings t "
        "WHERE t.dataset_id = %s AND t.nodata_fraction < 0.1 AND ST_Within(ST_Centroid(t.geometry), ST_GeomFromGeoJSON(%s)) "
        "ORDER BY md5(t.id::text) LIMIT %s", (row['dataset_id'], json.dumps(row['aoi']), MAX_CANDIDATES)).fetchall()
    if not tiles:
        return None, []
    epsg = utm_epsg(tiles[0]['lon'], tiles[0]['lat'])
    fwd = Transformer.from_crs(4326, epsg, always_xy=True)
    aoi = shp_transform(fwd.transform, shape(row['aoi'])).buffer(0)
    cells = {}
    for t in tiles:
        x, y = fwd.transform(t['lon'], t['lat'])
        x0, y0 = math.floor((x - CELL / 2) / 10) * 10, math.floor((y - CELL / 2) / 10) * 10
        cell = box(x0, y0, x0 + CELL, y0 + CELL)
        if cell.intersection(aoi).area / cell.area >= 0.9:
            cells[(x0, y0)] = cell
    if not cells:
        return epsg, []
    # Prediction polygons near the candidates, rasterised per cell at 0.5 m for the cover fractions.
    union = shp_transform(Transformer.from_crs(epsg, 4326, always_xy=True).transform,
                          box(*np.array([c.bounds for c in cells.values()]).min(0)[:2],
                              *np.array([c.bounds for c in cells.values()]).max(0)[2:]))
    polys = {}
    for layer, table in TABLES.items():
        polys[layer] = [transform_geom(4326, f'EPSG:{epsg}', r['g']) for r in db.execute(
            f"SELECT ST_AsGeoJSON(geometry)::jsonb AS g FROM {table} WHERE label_id = %s AND NOT is_deleted "
            "AND ST_Intersects(geometry, ST_GeomFromText(%s, 4326))", (row[f'{layer}_label_id'], union.wkt)).fetchall()]
    out = []
    shapes = {l: [(shape(g), g) for g in polys[l]] for l in polys}
    for (x0, y0), cell in cells.items():
        affine = from_bounds(x0, y0, x0 + CELL, y0 + CELL, 100, 100)
        frac = {}
        for layer in TABLES:
            near = [(g, 1) for s, g in shapes[layer] if s.intersects(cell)]
            frac[layer] = float(rasterize(near, out_shape=(100, 100), transform=affine).mean()) if near else 0.0
        out.append({'x0': x0, 'y0': y0, 'deadwood': frac['deadwood'], 'forest_cover': frac['forest_cover'],
                    'stratum': list(stratum(frac['deadwood'], frac['forest_cover']))})
    return epsg, out


def pick(cells, n, seed):
    """Square-root allocation over label strata; weight = area share each crop stands for."""
    rng = np.random.default_rng(seed)
    keys = sorted({tuple(c['stratum']) for c in cells})
    members = {k: [i for i, c in enumerate(cells) if tuple(c['stratum']) == k] for k in keys}
    n = min(n, len(cells))
    root = np.array([math.sqrt(len(members[k])) for k in keys])
    quota = np.maximum(1, np.floor(n * root / root.sum())).astype(int)
    while quota.sum() < n and (quota < [len(members[k]) for k in keys]).any():
        gap = n * root / root.sum() - quota
        gap[quota >= [len(members[k]) for k in keys]] = -np.inf
        quota[int(np.argmax(gap))] += 1
    chosen = []
    for k, q in zip(keys, quota):
        take = rng.choice(members[k], size=min(q, len(members[k])), replace=False)
        chosen += [(i, len(members[k]) / len(take)) for i in take]
    total = sum(w for _, w in chosen)
    return [{**cells[i], 'weight': w / total} for i, w in chosen]


def cut(row, epsg, c, directory):
    """Read the COG window around the cell and warp it onto the cell's 5 cm UTM grid."""
    if (directory / 'truth.json').exists():
        return
    x0, y0 = c['x0'], c['y0']
    dst = from_bounds(x0, y0, x0 + CELL, y0 + CELL, OUT_PX, OUT_PX)
    url = COG_ROOT + quote(row['cog_path'], safe='/')
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', GDAL_HTTP_TIMEOUT='60'), rasterio.open(url) as src:
        b = transform_bounds(f'EPSG:{epsg}', src.crs, x0 - 5, y0 - 5, x0 + CELL + 5, y0 + CELL + 5)
        win = window_from_bounds(*b, transform=src.transform).round_offsets().round_lengths()
        win = win.intersection(rasterio.windows.Window(0, 0, src.width, src.height))
        scale = max(1.0, max(win.width, win.height) / (OUT_PX * 1.2))  # never read finer than needed
        h, w = max(1, round(win.height / scale)), max(1, round(win.width / scale))
        data = src.read([1, 2, 3], window=win, out_shape=(3, h, w), resampling=Resampling.bilinear)
        valid = src.dataset_mask(window=win, out_shape=(h, w), resampling=Resampling.nearest)
        src_t = rasterio.windows.transform(win, src.transform) * rasterio.Affine.scale(win.width / w, win.height / h)
        rgb = np.zeros((3, OUT_PX, OUT_PX), 'uint8'); mask = np.zeros((OUT_PX, OUT_PX), 'uint8')
        for i in range(3):
            reproject(data[i], rgb[i], src_transform=src_t, src_crs=src.crs, dst_transform=dst, dst_crs=f'EPSG:{epsg}',
                      resampling=Resampling.bilinear)
        reproject(valid, mask, src_transform=src_t, src_crs=src.crs, dst_transform=dst, dst_crs=f'EPSG:{epsg}',
                  resampling=Resampling.nearest)
    ok = mask > 0
    directory.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgb.transpose(1, 2, 0)).save(directory / 'raw.jpg', quality=92)
    env = transform_bounds(f'EPSG:{epsg}', 4326, x0, y0, x0 + CELL, y0 + CELL)
    fractions = {}
    with analyst() as db:
        for layer, table in TABLES.items():
            geoms = [transform_geom(4326, f'EPSG:{epsg}', r['g']) for r in db.execute(
                f"SELECT ST_AsGeoJSON(geometry)::jsonb AS g FROM {table} WHERE label_id = %s AND NOT is_deleted "
                "AND ST_Intersects(geometry, ST_MakeEnvelope(%s,%s,%s,%s,4326))", (row[f'{layer}_label_id'], *env)).fetchall()]
            m = (rasterize([(g, 1) for g in geoms], out_shape=(OUT_PX, OUT_PX), transform=dst) > 0 if geoms
                 else np.zeros((OUT_PX, OUT_PX), bool)) & ok
            rgba(m, COLORS[layer], False).save(directory / f'{layer}-fill.png')
            rgba(m, COLORS[layer], True).save(directory / f'{layer}-outline.png')
            fractions[layer] = float(m.mean())
    (directory / 'truth.json').write_text(json.dumps({
        'dataset_id': row['dataset_id'], 'strategy': 'stratum dw%d fc%d' % tuple(c['stratum']), 'mpp': CELL / OUT_PX,
        'size': [OUT_PX, OUT_PX], 'predicted_fraction': fractions, 's2_cell': {'epsg': epsg, 'x0': x0, 'y0': y0},
        'valid_fraction': float(ok.mean()), 'weight': c['weight']}))


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--datasets', type=int, nargs='+', required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    a.output.mkdir(parents=True, exist_ok=True)
    path = a.output / 'picks.json'
    picks = json.loads(path.read_text()) if path.exists() else {}
    with analyst() as db:
        rows = {r['dataset_id']: r for r in db.execute(POOL_SQL + ' AND d.id = ANY(%s)', (a.datasets,)).fetchall()}
    for dataset_id in a.datasets:
        if str(dataset_id) in picks or dataset_id not in rows:
            continue
        row = rows[dataset_id]
        try:  # one read-only transaction per dataset, so one slow dataset cannot poison the rest
            with analyst() as db:
                hectares = db.execute("SELECT ST_Area(ST_GeomFromGeoJSON(%s)::geography) / 1e4 AS ha",
                                      (json.dumps(row['aoi']),)).fetchone()['ha']
                epsg, cells = candidates(db, row)
        except Exception as e:
            print({'dataset': dataset_id, 'error': f'{type(e).__name__}: {str(e)[:120]}'}, flush=True)
            continue
        picks[str(dataset_id)] = {'hectares': hectares, 'epsg': epsg, 'candidates': len(cells),
                                  'crops': pick(cells, crop_count(hectares), dataset_id) if cells else []}
        path.write_text(json.dumps(picks, indent=1))
        print({'dataset': dataset_id, 'ha': round(hectares, 1), 'candidates': len(cells),
               'crops': len(picks[str(dataset_id)]['crops'])}, flush=True)
    for dataset_id in a.datasets:
        entry = picks.get(str(dataset_id))
        for n, c in enumerate((entry or {}).get('crops', []), 1):
            try:
                cut(rows[dataset_id], entry['epsg'], c, a.output / f'{dataset_id}-{n}')
            except Exception as e:
                print({'dataset': dataset_id, 'crop': n, 'error': f'{type(e).__name__}: {str(e)[:120]}'}, flush=True)
