"""Per-dataset prediction statistics and scene embeddings for every usable human audit.

Read-only analyst SELECTs. Features come from the predictions, the imagery metadata and
the tile embeddings only; audit fields are kept as labels, never as features.
"""
import argparse
import json
import math
from pathlib import Path

import numpy as np

from analyst import analyst

AUDITS_SQL = """
WITH pref AS (
  SELECT l.dataset_id, l.label_data::text AS layer, l.id, l.created_at
  FROM v2_labels l
  WHERE l.is_active AND l.label_source = 'model_prediction' AND l.label_data IN ('deadwood', 'forest_cover')
    AND EXISTS (SELECT 1 FROM v2_model_preferences p
                WHERE p.label_data = l.label_data::text AND l.model_config @> p.model_config))
SELECT d.id AS dataset_id, d.platform::text AS platform, d.aquisition_month AS month,
  a.deadwood_quality::text AS deadwood_quality, a.forest_cover_quality::text AS forest_cover_quality,
  a.audited_by::text AS auditor, a.audit_date,
  m.metadata->'biome'->>'biome_name' AS biome,
  (c.cog_info->'GEO'->'Resolution'->>0)::float AS cog_res, c.cog_info->'GEO'->>'CRS' AS cog_crs,
  ST_Y(ao.c) AS lat, ST_X(ao.c) AS lon, ao.area_deg AS aoi_area_deg,
  dw.id AS deadwood_label_id, fc.id AS forest_cover_label_id
FROM dataset_audit a
JOIN v2_datasets d ON d.id = a.dataset_id
JOIN v2_cogs c ON c.dataset_id = d.id
JOIN pref dw ON dw.dataset_id = d.id AND dw.layer = 'deadwood' AND dw.created_at <= a.audit_date
JOIN pref fc ON fc.dataset_id = d.id AND fc.layer = 'forest_cover' AND fc.created_at <= a.audit_date
LEFT JOIN v2_metadata m ON m.dataset_id = d.id
LEFT JOIN LATERAL (SELECT ST_Centroid(g) AS c, ST_Area(g) AS area_deg FROM
    (SELECT ST_GeomFromGeoJSON(COALESCE(geometry->'geometry', geometry)) AS g FROM v2_aois
     WHERE dataset_id = d.id ORDER BY created_at DESC, id DESC LIMIT 1) x) ao ON true
WHERE NOT d.archived AND a.audited_by IS NOT NULL
  AND a.deadwood_quality IS NOT NULL AND a.forest_cover_quality IS NOT NULL AND ao.c IS NOT NULL
"""
TABLES = {'deadwood': 'v2_deadwood_geometries', 'forest_cover': 'v2_forest_cover_geometries'}


def m2_per_deg2(lat):
    return (111320 ** 2) * math.cos(math.radians(lat))


def collect():
    with analyst() as db:
        rows = db.execute(AUDITS_SQL).fetchall()
        for layer, table in TABLES.items():
            ids = [r[layer + '_label_id'] for r in rows]
            stats = {}
            for start in range(0, len(ids), 200):
                for s in db.execute(f'SELECT label_id, count(*) AS n, sum(ST_Area(geometry)) AS a, '
                                    'avg(ST_NPoints(geometry)) AS v, max(ST_Area(geometry)) AS amax '
                                    f'FROM {table} WHERE label_id = ANY(%s) AND NOT is_deleted GROUP BY 1',
                                    (ids[start:start + 200],)).fetchall():
                    stats[s['label_id']] = s
            for r in rows:
                s = stats.get(r[layer + '_label_id'], {'n': 0, 'a': 0, 'v': 0, 'amax': 0})
                r[layer] = {k: float(s[k] or 0) for k in ('n', 'a', 'v', 'amax')}
        embeddings = {}
        ids = [r['dataset_id'] for r in rows]
        for start in range(0, len(ids), 200):
            for e in db.execute("SELECT dataset_id, avg(embedding)::text AS e FROM v2_tile_embeddings "
                                "WHERE dataset_id = ANY(%s) AND nodata_fraction < 0.5 GROUP BY 1",
                                (ids[start:start + 200],)).fetchall():
                embeddings[e['dataset_id']] = json.loads(e['e'])
    out = []
    for r in rows:
        k = m2_per_deg2(r['lat'])
        aoi_m2 = max(1.0, r['aoi_area_deg'] * k)
        res = r['cog_res'] * (math.cos(math.radians(r['lat'])) if r['cog_crs'] == 'EPSG:3857' else 1)
        if r['cog_crs'] == 'EPSG:4326':
            res = r['cog_res'] * 111320
        feats = {'log_aoi_ha': math.log10(aoi_m2 / 1e4 + 1e-3), 'res_cm': res * 100, 'abs_lat': abs(r['lat']),
                 'month_sin': math.sin(2 * math.pi * (r['month'] or 6) / 12),
                 'month_cos': math.cos(2 * math.pi * (r['month'] or 6) / 12),
                 'south': float(r['lat'] < 0), 'drone': float(r['platform'] == 'drone')}
        for layer in TABLES:
            s = r[layer]
            area = s['a'] * k
            feats.update({f'{layer}_frac': area / aoi_m2, f'{layer}_log_n': math.log10(s['n'] + 1),
                          f'{layer}_n_per_ha': s['n'] / (aoi_m2 / 1e4),
                          f'{layer}_mean_m2': area / max(1, s['n']), f'{layer}_max_frac': s['amax'] * k / aoi_m2,
                          f'{layer}_vertices': s['v']})
        out.append({'dataset_id': r['dataset_id'], 'auditor': r['auditor'][:4], 'audit_date': str(r['audit_date']),
                    'biome': r['biome'], 'lat': r['lat'], 'lon': r['lon'],
                    'deadwood_bad': r['deadwood_quality'] == 'bad', 'forest_cover_bad': r['forest_cover_quality'] == 'bad',
                    'features': feats, 'embedding': embeddings.get(r['dataset_id'])})
    return out


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    rows = collect()
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps(rows) + '\n')
    print({'audits': len(rows), 'deadwood_bad': sum(r['deadwood_bad'] for r in rows),
           'forest_bad': sum(r['forest_cover_bad'] for r in rows),
           'with_embedding': sum(r['embedding'] is not None for r in rows)})
