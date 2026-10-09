"""Deterministic linter for tiling artifacts in the rendered prediction masks.

Model output is produced tile by tile in the raster grid, so a broken tile leaves mask
edges that run perfectly straight along rows or columns for many metres. Natural crown
and stand boundaries almost never do. For each rendered view (overview and 3x3 grid)
this finds straight axis-aligned mask edges at least --min-m metres long, counting only
edges with valid area of interest on both sides (AOI borders are not artifacts).
Reads only the rendered masks, the AOI and the COG header; no model, no writes elsewhere.
"""
import argparse
import json
from pathlib import Path
from urllib.parse import quote

import numpy as np
from PIL import Image
import rasterio
from rasterio.features import rasterize
from rasterio.warp import transform_geom
from rasterio.windows import Window, transform as window_transform
from scipy import ndimage

from analyst import analyst

LAYERS = ('deadwood', 'forest_cover')
COG_ROOT = 'https://data2.deadtrees.earth/cogs/v1/'


def runs(edges, min_px):
    """Pixels of horizontal runs (along axis 1) of at least min_px, and the run count."""
    out = np.zeros_like(edges)
    count = 0
    for y in range(edges.shape[0]):
        row = edges[y]
        if row.sum() < min_px:
            continue
        labels, n = ndimage.label(row)
        if not n:
            continue
        sizes = ndimage.sum(row, labels, range(1, n + 1))
        for i, size in enumerate(sizes, 1):
            if size >= min_px:
                out[y][labels == i] = True
                count += 1
    return out, count


def lint_view(mask, support, mpp, min_m):
    inner = ndimage.binary_erosion(support, iterations=3)
    min_px = max(8, int(round(min_m / mpp)))
    # Edge between row y and y+1 (horizontal line), and between column x and x+1 (vertical line).
    horizontal = (mask[:-1] != mask[1:]) & inner[:-1] & inner[1:]
    vertical = (mask[:, :-1] != mask[:, 1:]) & inner[:, :-1] & inner[:, 1:]
    h_runs, h_n = runs(horizontal, min_px)
    v_runs, v_n = runs(vertical.T, min_px)
    edge_px = int(horizontal.sum() + vertical.sum())
    straight_px = int(h_runs.sum() + v_runs.sum())
    seams = np.zeros(mask.shape, bool)
    seams[:-1] |= h_runs
    seams[:, :-1] |= v_runs.T
    return {'edge_px': edge_px, 'straight_px': straight_px, 'runs': h_n + v_n,
            'straight_m': round(straight_px * mpp, 1)}, seams


def lint_dataset(root, dataset_id, min_m, out_dir):
    directory = root / 'datasets' / str(dataset_id)
    evidence = json.loads((directory / 'evidence.json').read_text())
    with analyst() as db:
        aoi = db.execute("SELECT COALESCE(geometry->'geometry', geometry) AS g FROM v2_aois WHERE dataset_id = %s "
                         "ORDER BY created_at DESC, id DESC LIMIT 1", (dataset_id,)).fetchone()['g']
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR'), \
            rasterio.open(COG_ROOT + quote(evidence['cog']['path'], safe='/')) as src:
        native, crs = src.transform, src.crs
    aoi_src = transform_geom(4326, crs, aoi)
    result = {'dataset_id': dataset_id, 'min_m': min_m, 'layers': {l: {'straight_m': 0.0, 'runs': 0, 'edge_px': 0,
                                                                         'straight_px': 0, 'views': {}} for l in LAYERS}}
    for view in evidence['views']:
        if view['kind'] == 'native':
            continue
        w, h = view['size']
        col, row, ww, wh = view['window']
        affine = window_transform(Window(col, row, ww, wh), native) * rasterio.Affine.scale(ww / w, wh / h)
        support = rasterize([(aoi_src, 1)], out_shape=(h, w), transform=affine, dtype='uint8') > 0
        name = 'O' if view['name'] == 'overview' else view['name'].upper()
        for layer in LAYERS:
            mask = np.asarray(Image.open(directory / f"{view['name']}-{layer}-fill.png"))[..., 3] > 0
            stats, seams = lint_view(mask, support, view['mpp'], min_m)
            entry = result['layers'][layer]
            entry['views'][name] = stats
            if view['kind'] == 'grid':  # the grid partitions the AOI; the overview repeats it coarser
                for k in ('straight_m', 'runs', 'edge_px', 'straight_px'):
                    entry[k] += stats[k]
            if stats['runs'] and out_dir:
                out_dir.mkdir(parents=True, exist_ok=True)
                overlay = np.zeros((h, w, 4), 'uint8')
                overlay[ndimage.binary_dilation(seams, iterations=2)] = (255, 0, 255, 255)
                Image.fromarray(overlay).save(out_dir / f"{view['name']}-{layer}-seams.png")
    for entry in result['layers'].values():
        entry['straight_share'] = round(entry['straight_px'] / max(1, entry['edge_px']), 4)
        entry['straight_m'] = round(entry['straight_m'], 1)
    return result


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--min-m', type=float, default=15.0, help='minimum straight edge length in metres')
    a = p.parse_args()
    selection = json.loads((a.root / 'selection.json').read_text())['datasets']
    results = []
    for d in selection:
        if not (a.root / 'datasets' / str(d['dataset_id']) / 'evidence.json').exists():
            continue
        results.append(lint_dataset(a.root, d['dataset_id'], a.min_m, a.root / 'lint' / str(d['dataset_id'])))
        r = results[-1]['layers']
        print(d['dataset_id'], {l: (r[l]['straight_m'], r[l]['runs'], r[l]['straight_share']) for l in LAYERS}, flush=True)
    (a.root / 'lint-tiles.json').write_text(json.dumps(results, indent=1) + '\n')
