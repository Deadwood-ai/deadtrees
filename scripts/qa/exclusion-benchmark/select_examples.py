"""Pick in-context example datasets for Sol from audited datasets outside the benchmark.

Examples cover the main audited failure modes plus usable (Great/OK) layers, each with
the auditor's grade and note as its caption. Every example is more than 10 km from
every benchmark dataset so no benchmark site leaks into the prompt.
"""
import argparse
import hashlib
import json
from pathlib import Path

from select_benchmark import km, load_pool, public

# (caption key, layer, audit grade, required note tag or None)
WANTED = [
    ('dw_burnt_missed', 'deadwood', 'bad', 'disturbance'),
    ('dw_vegetation_marked_dead', 'deadwood', 'bad', 'confuser_vegetation'),
    ('dw_water_or_snow_marked_dead', 'deadwood', 'bad', 'confuser_snow_water'),
    ('dw_ground_marked_dead', 'deadwood', 'bad', 'confuser_ground'),
    ('dw_dead_trees_missed', 'deadwood', 'bad', 'omission'),
    ('fc_layer_missing_or_partial', 'forest_cover', 'bad', 'missing_layer'),
    ('fc_shrubs_crops_marked_forest', 'forest_cover', 'bad', 'commission'),
    ('fc_trees_missed', 'forest_cover', 'bad', 'omission'),
    ('both_great', None, 'great', None),
    ('both_ok', None, 'sentinel_ok', None),
]


def order(row):
    return hashlib.sha256(f"examples-v1:{row['dataset_id']}".encode()).hexdigest()


def pick(rows, benchmark):
    chosen = []
    for key, layer, grade, tag in WANTED:
        candidates = []
        for r in sorted(rows, key=order):
            if r in chosen or any(km(r, b) <= 10 for b in benchmark + chosen):
                continue
            if layer:
                note = r[layer + '_notes'] or ''
                if r[layer + '_quality'] != grade or tag not in r['tags'].get(layer, []) or len(note) < 15:
                    continue
            elif not (r['deadwood_quality'] == grade and r['forest_cover_quality'] == grade):
                continue
            candidates.append(r)
            break
        if candidates:
            candidates[0]['example'] = key
            chosen.append(candidates[0])
    return chosen


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True, help='benchmark root with selection.json')
    p.add_argument('--exposed', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    benchmark = json.loads((a.root / 'selection.json').read_text())['datasets']
    exposed = {int(x) for x in a.exposed.read_text().split()} | {d['dataset_id'] for d in benchmark}
    rows = load_pool(exposed)
    chosen = pick(rows, benchmark)
    out = [dict(public(r), role='example', example=r['example']) for r in chosen]
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps({'datasets': out}, indent=2, default=str) + '\n')
    print([(d['example'], d['dataset_id']) for d in out])
