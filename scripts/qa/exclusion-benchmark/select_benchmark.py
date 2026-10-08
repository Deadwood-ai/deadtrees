"""Select a small, diverse dataset-level exclusion benchmark from audited datasets.

Read-only analyst SELECTs. Audit grades and notes only steer the selection; they
are candidate labels until the blind hand labels confirm or overturn them.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import re
from pathlib import Path

import numpy as np

from analyst import analyst

LAYERS = ('deadwood', 'forest_cover')

# Failure modes the auditors describe in free text, per layer.
NOTE_TAGS = {
    'deadwood': {
        'omission': r'miss|not detected|undetected|not (?:been )?(?:found|recogni)|few (?:dead )?trees? detected|no brown',
        'confuser_ground': r'soil|ground|road|rock|sand|gravel|building|roof|tower|metal',
        'confuser_vegetation': r'grass|shrub|bush|crop|meadow|flower|purple|red leav|blossom|lichen|reed',
        'confuser_snow_water': r'snow|water|lake|river|ice',
        'phenology': r'season|leaf.?off|leafless|winter|autumn|not yet green|bare trees|phenolog',
        'disturbance': r'burn|fire|windthrow|storm|clearcut|harvest',
        'shadow': r'shadow|dark',
    },
    'forest_cover': {
        'missing_layer': r"doesn.?t exist|does not exist|layer missing|^\s*missing\s*$|no prediction|empty",
        'coverage_gap': r'not cover|hole|side of the image|artifact|cut off|edge|stripe|tile',
        'omission': r'miss|not detected|brown trees|dead trees',
        'commission': r'bush|shrub|crop|grass|field|meadow|hedge',
    },
}


def note_tags(layer, note):
    note = (note or '').lower()
    tags = [t for t, pattern in NOTE_TAGS[layer].items() if re.search(pattern, note)]
    return tags or (['unspecified'] if not note.strip() else ['other'])


POOL_SQL = """
WITH pref AS (
  SELECT l.dataset_id, l.label_data::text AS layer, l.id, l.version, l.created_at
  FROM v2_labels l
  WHERE l.is_active AND l.label_source = 'model_prediction'
    AND l.label_data IN ('deadwood', 'forest_cover')
    AND EXISTS (SELECT 1 FROM v2_model_preferences p
                WHERE p.label_data = l.label_data::text AND l.model_config @> p.model_config))
SELECT d.id AS dataset_id, d.platform::text, d.aquisition_year, d.aquisition_month,
  a.audit_date, a.audited_by::text AS auditor, a.deadwood_quality::text AS deadwood_quality,
  a.forest_cover_quality::text AS forest_cover_quality, a.deadwood_notes, a.forest_cover_notes,
  a.final_assessment::text, a.has_valid_phenology, a.has_cog_issue, a.is_georeferenced,
  m.metadata->'biome'->>'biome_name' AS biome, m.metadata->'gadm'->>'admin_level_1' AS country,
  ST_X(ao.c) AS lon, ST_Y(ao.c) AS lat,
  dw.id AS deadwood_label_id, fc.id AS forest_cover_label_id
FROM dataset_audit a
JOIN v2_datasets d ON d.id = a.dataset_id
JOIN v2_cogs c ON c.dataset_id = d.id
JOIN pref dw ON dw.dataset_id = d.id AND dw.layer = 'deadwood' AND dw.created_at <= a.audit_date
JOIN pref fc ON fc.dataset_id = d.id AND fc.layer = 'forest_cover' AND fc.created_at <= a.audit_date
LEFT JOIN v2_metadata m ON m.dataset_id = d.id
LEFT JOIN LATERAL (SELECT ST_Centroid(ST_GeomFromGeoJSON(COALESCE(geometry->'geometry', geometry))) AS c FROM v2_aois WHERE dataset_id = d.id
                   ORDER BY created_at DESC, id DESC LIMIT 1) ao ON true
WHERE d.data_access = 'public' AND NOT d.archived AND a.audited_by IS NOT NULL
  AND a.deadwood_quality IS NOT NULL AND a.forest_cover_quality IS NOT NULL
  AND ao.c IS NOT NULL
"""


def load_pool(exposed):
    with analyst() as db:
        rows = [r for r in db.execute(POOL_SQL).fetchall() if r['dataset_id'] not in exposed]
        ids = [r['dataset_id'] for r in rows]
        embeddings = {}
        for start in range(0, len(ids), 200):
            for r in db.execute("SELECT dataset_id, avg(embedding)::text AS e FROM v2_tile_embeddings "
                                "WHERE dataset_id = ANY(%s) AND nodata_fraction < 0.5 GROUP BY 1",
                                (ids[start:start + 200],)).fetchall():
                embeddings[r['dataset_id']] = np.array(json.loads(r['e']), dtype='float32')
    rows = [r for r in rows if r['dataset_id'] in embeddings]
    for r in rows:
        v = embeddings[r['dataset_id']]
        r['embedding'] = v / np.linalg.norm(v)
        r['bad_layers'] = [l for l in LAYERS if r[l + '_quality'] == 'bad']
        r['tags'] = {l: note_tags(l, r[l + '_notes']) for l in r['bad_layers']}
    return rows


def km(a, b):
    lat1, lon1, lat2, lon2 = map(np.radians, (a['lat'], a['lon'], b['lat'], b['lon']))
    h = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 12742 * np.arcsin(np.sqrt(h))


def greedy(candidates, chosen, count, score, auditor_cap):
    """Farthest-point selection in embedding space with site separation and auditor caps."""
    picked = []
    auditors = Counter(r['auditor'] for r in chosen)
    while len(picked) < count:
        pool = [r for r in candidates if r not in picked and r not in chosen
                and auditors[r['auditor']] < auditor_cap
                and all(km(r, s) > 10 for s in chosen + picked)]
        if not pool:
            break
        ref = chosen + picked
        def distance(r):
            if not ref:
                return 1.0
            return 1 - max(float(r['embedding'] @ s['embedding']) for s in ref)
        best = max(pool, key=lambda r: (score(r, picked) + distance(r), -r['dataset_id']))
        picked.append(best)
        auditors[best['auditor']] += 1
    return picked


def select(rows, n_bad, n_keep, auditor_cap):
    bad = [r for r in rows if r['bad_layers']]
    keep = [r for r in rows if not r['bad_layers']
            and r['deadwood_quality'] in ('great', 'sentinel_ok')
            and r['forest_cover_quality'] in ('great', 'sentinel_ok')]
    # Reward unseen failure modes and layer combinations so rare modes enter early.
    def mode_bonus(r, picked):
        seen = Counter((l, t) for p in picked for l in p['bad_layers'] for t in p['tags'][l])
        combos = Counter(tuple(p['bad_layers']) for p in picked)
        new = sum(1 for l in r['bad_layers'] for t in r['tags'][l] if seen[(l, t)] == 0)
        rare = sum(1 / (1 + seen[(l, t)]) for l in r['bad_layers'] for t in r['tags'][l])
        return 2 * new + rare + 0.5 / (1 + combos[tuple(r['bad_layers'])])
    chosen_bad = greedy(bad, [], n_bad, mode_bonus, auditor_cap)
    # Half the keep set are hard negatives: the closest-looking good dataset per selected bad one.
    hard = []
    for b in chosen_bad[: n_keep // 2 * 2: 2]:
        options = [r for r in keep if r not in hard and all(km(r, s) > 10 for s in chosen_bad + hard)]
        if options:
            hard.append(max(options, key=lambda r: float(r['embedding'] @ b['embedding'])))
    diverse = greedy(keep, chosen_bad + hard, n_keep - len(hard), lambda r, p: 0.0, auditor_cap + 4)
    for r in hard:
        r['role'] = 'hard_negative'
    for r in diverse:
        r['role'] = 'diverse_keep'
    for r in chosen_bad:
        r['role'] = 'audited_bad'
    return chosen_bad + hard + diverse


def public(r):
    out = {k: v for k, v in r.items() if k not in ('embedding', 'auditor')}
    out['auditor'] = f"auditor-{r['auditor'][:4]}"  # pseudonymous: reliability only, no identities
    return out


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--exposed', type=Path, required=True, help='dataset IDs used in earlier experiments')
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--bad', type=int, default=36)
    p.add_argument('--keep', type=int, default=24)
    p.add_argument('--auditor-cap', type=int, default=8)
    a = p.parse_args()
    exposed = {int(x) for x in a.exposed.read_text().split()}
    rows = load_pool(exposed)
    chosen = select(rows, a.bad, a.keep, a.auditor_cap)
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps({
        'created_at': datetime.now(timezone.utc).isoformat(),
        'pool': {'datasets': len(rows), 'audited_bad': sum(1 for r in rows if r['bad_layers'])},
        'rule': 'Public, unarchived, audited by a person; both preferred predictions predate the audit; '
                'not used in earlier experiments; >10 km apart; audited-bad chosen for unseen failure modes '
                'plus embedding distance; half the keep set are nearest-looking good datasets.',
        'datasets': [public(r) for r in chosen],
    }, indent=2, default=str) + '\n')
    print(json.dumps({'pool': len(rows), 'selected': len(chosen),
                      'roles': Counter(r['role'] for r in chosen),
                      'auditors': len({r['auditor'] for r in chosen})}, default=str))
