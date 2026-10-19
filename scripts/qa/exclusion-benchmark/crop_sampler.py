"""Representative crop sample per dataset: spread over area and land cover, not over suspected errors.

Candidates are the dataset's stored CLIP tiles (v2_tile_embeddings, about 52 m, the crop size)
that have image data. Tiles are grouped by appearance (k-means on their embeddings, a stand-in
for land cover); each group gets crops in proportion to its area, at least one. Tiles with
no tree or deadwood prediction touching them ("no signal") are skipped, except a small reserve that
keeps missed trees in view. Every crop carries a weight = the area share it stands for, so
the dataset share of major crops stays unbiased. Count: 1 crop per 2 ha, 10 to 40.
Writes <output>/picks.json and cuts the crops with gold_crops.build. Read-only analyst SQL.
"""
import argparse
import json
from pathlib import Path

import numpy as np
from sklearn.cluster import KMeans

from analyst import analyst
from gold_crops import POOL_SQL, build

MAX_CANDIDATES = 600  # random subset for very large datasets
NO_SIGNAL_SHARE = 0.1  # reserve of crops from tiles without any prediction


def crop_count(hectares):
    return int(min(40, max(10, round(hectares / 2))))


def candidates(db, row):
    tiles = db.execute(
        "SELECT t.id, ST_X(ST_Centroid(t.geometry)) AS lon, ST_Y(ST_Centroid(t.geometry)) AS lat, t.embedding::text AS e "
        "FROM v2_tile_embeddings t WHERE t.dataset_id = %s AND t.nodata_fraction < 0.1 "
        "AND ST_Within(ST_Centroid(t.geometry), ST_GeomFromGeoJSON(%s)) ORDER BY md5(t.id::text) LIMIT %s",
        (row['dataset_id'], json.dumps(row['aoi']), MAX_CANDIDATES)).fetchall()
    if not tiles:
        return []
    ids = [t['id'] for t in tiles]
    # Presence, not area: a tile has signal when any prediction touches it. EXISTS on the
    # spatial index stays fast on datasets with 100k+ polygons, where area sums time out.
    present = {}
    for layer, table in (('deadwood', 'v2_deadwood_geometries'), ('forest_cover', 'v2_forest_cover_geometries')):
        for r in db.execute(
                f"SELECT t.id, EXISTS (SELECT 1 FROM {table} g WHERE g.label_id = %s AND NOT g.is_deleted "
                f"AND ST_Intersects(g.geometry, t.geometry)) AS hit FROM v2_tile_embeddings t WHERE t.id = ANY(%s)",
                (row[f'{layer}_label_id'], ids)).fetchall():
            present.setdefault(r['id'], {})[layer] = bool(r['hit'])
    return [{'tile_id': t['id'], 'lon': t['lon'], 'lat': t['lat'], 'embedding': json.loads(t['e']),
             **present.get(t['id'], {'deadwood': False, 'forest_cover': False})} for t in tiles]


def pick(tiles, n, seed):
    """Area-proportional sample over embedding groups; returns tiles with group and weight."""
    rng = np.random.default_rng(seed)
    X = np.array([t['embedding'] for t in tiles]); X /= np.linalg.norm(X, axis=1, keepdims=True)
    k = int(min(6, max(1, len(tiles) // 5)))
    groups = KMeans(n_clusters=k, n_init=10, random_state=seed).fit_predict(X) if k > 1 else np.zeros(len(tiles), int)
    signal = np.array([t['forest_cover'] or t['deadwood'] for t in tiles])
    n = min(n, len(tiles))
    reserve = min(int((~signal).sum()), max(1, round(NO_SIGNAL_SHARE * n))) if (~signal).any() else 0
    chosen = []
    # Signal tiles: each embedding group in proportion to its signal area, at least one.
    sig_groups = [g for g in range(k) if (signal & (groups == g)).any()]
    sizes = np.array([(signal & (groups == g)).sum() for g in sig_groups], float)
    quota = np.maximum(1, np.round((n - reserve) * sizes / sizes.sum())).astype(int) if len(sizes) else []
    for g, q in zip(sig_groups, quota):
        members = np.flatnonzero(signal & (groups == g))
        take = rng.choice(members, size=min(q, len(members)), replace=False)
        chosen += [(i, (signal & (groups == g)).sum() / len(take)) for i in take]
    if reserve:
        members = np.flatnonzero(~signal)
        take = rng.choice(members, size=reserve, replace=False)
        chosen += [(i, (~signal).sum() / reserve) for i in take]
    total = sum(w for _, w in chosen)
    return [{**{k2: v for k2, v in tiles[i].items() if k2 != 'embedding'}, 'group': int(groups[i]),
             'signal': bool(signal[i]), 'weight': float(w / total)} for i, w in chosen]


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--datasets', type=int, nargs='+', required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--no-cut', action='store_true', help='only write picks.json')
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
            hectares = db.execute("SELECT ST_Area(ST_GeomFromGeoJSON(%s)::geography) / 1e4 AS ha",
                                  (json.dumps(row['aoi']),)).fetchone()['ha']
            tiles = candidates(db, row)
            picks[str(dataset_id)] = {'hectares': hectares, 'candidates': len(tiles),
                                      'crops': pick(tiles, crop_count(hectares), dataset_id) if tiles else []}
            path.write_text(json.dumps(picks, indent=1))
            print({'dataset': dataset_id, 'ha': round(hectares, 1), 'candidates': len(tiles), 'crops': len(picks[str(dataset_id)]['crops'])}, flush=True)
    if a.no_cut:
        raise SystemExit
    for dataset_id in a.datasets:
        for n, c in enumerate(picks.get(str(dataset_id), {}).get('crops', []), 1):
            try:
                build(rows[dataset_id], f"group {c['group']}" + ('' if c['signal'] else ' (no signal)'), a.output,
                      np.random.default_rng(n), f'{dataset_id}-{n}', center=(c['lon'], c['lat']))
            except Exception as e:
                print({'dataset': dataset_id, 'crop': n, 'error': f'{type(e).__name__}: {str(e)[:120]}'}, flush=True)
