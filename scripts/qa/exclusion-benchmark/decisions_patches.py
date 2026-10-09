"""Run per-crop Decisions predicates on the reference-patch truth set and score them.

Truth is measured per patch by build_patch_truth.py (commission and omission against
the validated editor reference), so each predicate gets an AUC without audit noise.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path

import numpy as np
from PIL import Image
from sklearn.metrics import roc_auc_score

from decisions_crops import PREDICATES, body, post, read_key
from sol_issue_finder import composite

CHECKS = {  # predicate -> (layer, measured error)
    'dw_missed_standing_dead': ('deadwood', 'omission'), 'dw_most_dead_missed': ('deadwood', 'omission'),
    'dw_no_blue_many_dead': ('deadwood', 'omission'),
    'dw_on_living_trees': ('deadwood', 'commission'), 'dw_on_ground_water_objects': ('deadwood', 'commission'),
    'dw_on_lying_wood': ('deadwood', 'commission'), 'dw_most_blue_wrong': ('deadwood', 'commission'),
    'dw_blue_but_no_dead': ('deadwood', 'commission'),
    'fc_missed_trees': ('forest_cover', 'omission'), 'fc_large_canopy_missed': ('forest_cover', 'omission'),
    'fc_on_non_trees': ('forest_cover', 'commission'), 'fc_gold_mostly_non_trees': ('forest_cover', 'commission'),
    'fc_filled_gaps': ('forest_cover', 'commission'),
    'dw_om_more_without_blue': ('deadwood', 'omission'), 'dw_om_blue_smaller': ('deadwood', 'omission'),
    'dw_om_large_dead_unmarked': ('deadwood', 'omission'), 'dw_om_compare_raw': ('deadwood', 'omission'),
    'dw_co_remove': ('deadwood', 'commission'), 'dw_co_most_wrong': ('deadwood', 'commission'),
    'dw_co_lying': ('deadwood', 'commission'),
    'fc_om_add': ('forest_cover', 'omission'), 'fc_co_remove': ('forest_cover', 'commission'),
}


def images(directory):
    raw = Image.open(directory / 'raw.jpg')
    return [raw] + [composite(raw, (directory / f'{l}-fill.png', directory / f'{l}-outline.png'))
                    for l in ('deadwood', 'forest_cover')]


def score(rows, min_px=50):
    out = {}
    for pred, (layer, kind) in CHECKS.items():
        pairs = [(r['answers'][pred], r['truth']['layers'][layer][kind]) for r in rows
                 if r['answers'].get(pred) is not None
                 and r['truth']['layers'][layer]['pred_px' if kind == 'commission' else 'ref_px'] > min_px]
        if not pairs:
            continue
        x, t = np.array(pairs).T
        for cut in (0.2, 0.4):
            y = t >= cut
            if 0 < y.sum() < len(y):
                out[f'{pred} vs {kind}>={cut:.0%}'] = {'auc': round(float(roc_auc_score(y, x)), 2),
                                                        'n': int(len(y)), 'positive': int(y.sum())}
    return out


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--truth', type=Path, required=True)
    p.add_argument('--run', type=Path, required=True)
    p.add_argument('--key-file', type=Path, required=True)
    p.add_argument('--predicates', default='v1')
    p.add_argument('--cap', type=int, default=400)
    a = p.parse_args()
    key = read_key(a.key_file)
    a.run.mkdir(parents=True, exist_ok=True)
    patches = sorted(d for d in a.truth.iterdir() if (d / 'truth.json').exists())

    def one(directory):
        out = a.run / f'{directory.name}.json'
        if out.exists():
            return json.loads(out.read_text())
        truth = json.loads((directory / 'truth.json').read_text())
        raw = post(body(images(directory), {'mpp': truth['mpp']}, PREDICATES[a.predicates]), key, a.cap)
        r = {'patch_id': truth['patch_id'], 'truth': truth,
             'answers': {x['name']: x.get('probability') for x in raw.get('answers', []) if x.get('type') == 'predicate'}}
        out.write_text(json.dumps(r))
        return r

    with ThreadPoolExecutor(8) as pool:
        rows = list(pool.map(one, patches))
    report = score(rows)
    (a.run / 'scores.json').write_text(json.dumps(report, indent=1) + '\n')
    for k, v in report.items():
        print(f"{k:50s} AUC {v['auc']:.2f}  (n={v['n']}, positive={v['positive']})")
