"""Crop-level check of Decisions failure-mode answers against human reference masks.

Uses the 42 prepared reference patches (51 m tiles with an editor-corrected mask). The
truth per tile is measured, not audited: commission = share of predicted pixels outside
the reference, omission = share of reference pixels the prediction misses. This separates
the model's ability from audit-label noise.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path

import numpy as np
from PIL import Image
from sklearn.metrics import roc_auc_score

from decisions_crops import CONTEXT, PREDICATES, body, post, read_key

COHORT = Path('/home/jj1049/dev/codex-worktrees/dt-prediction-failures-20261007/.local/prediction-cohort')


def mask(path):
    return np.asarray(Image.open(path).convert('RGBA'))[..., 3] > 0


def tile_truth(case):
    a = case['assets']
    valid = mask(COHORT / a['valid']) if a['valid'].endswith('.png') else None
    out = {}
    for layer in ('deadwood', 'forest_cover'):
        pred, ref = mask(COHORT / a[f'prediction-{layer}-fill']), mask(COHORT / a[f'reference-{layer}-fill'])
        out[layer] = {'commission': float((pred & ~ref).sum() / max(1, pred.sum())),
                      'omission': float((ref & ~pred).sum() / max(1, ref.sum())),
                      'pred_px': int(pred.sum()), 'ref_px': int(ref.sum())}
    return out


def images(case):
    from sol_issue_finder import composite
    a = case['assets']
    raw = Image.open(COHORT / a['raw'])
    return [raw] + [composite(raw, (COHORT / a[f'prediction-{l}-fill'], COHORT / a[f'prediction-{l}-outline']))
                    for l in ('deadwood', 'forest_cover')]


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--run', type=Path, required=True)
    p.add_argument('--key-file', type=Path, required=True)
    p.add_argument('--predicates', default='v1')
    a = p.parse_args()
    cases = [c for c in json.loads((COHORT / 'manifest.json').read_text())['cases']
             if c['source_kind'] == 'prepared_reference_patch' and c['condition'] == 'original_prediction']
    key = read_key(a.key_file)
    a.run.mkdir(parents=True, exist_ok=True)

    def one(case):
        out = a.run / f"{case['id']}.json"
        if out.exists():
            return json.loads(out.read_text())
        raw = post(body(images(case), {'mpp': case['mpp']}, PREDICATES[a.predicates]), key, 200)
        r = {'case': case['id'], 'dataset_id': case['dataset_id'], 'truth': tile_truth(case),
             'answers': {x['name']: x.get('probability') for x in raw.get('answers', []) if x.get('type') == 'predicate'}}
        out.write_text(json.dumps(r))
        return r

    with ThreadPoolExecutor(8) as pool:
        rows = list(pool.map(one, cases))
    checks = {'dw_missed_standing_dead': ('deadwood', 'omission'), 'dw_most_dead_missed': ('deadwood', 'omission'),
              'dw_on_living_trees': ('deadwood', 'commission'), 'dw_on_ground_water_objects': ('deadwood', 'commission'),
              'dw_on_lying_wood': ('deadwood', 'commission'), 'dw_most_blue_wrong': ('deadwood', 'commission'),
              'fc_missed_trees': ('forest_cover', 'omission'), 'fc_large_canopy_missed': ('forest_cover', 'omission'),
              'fc_on_non_trees': ('forest_cover', 'commission'), 'fc_gold_mostly_non_trees': ('forest_cover', 'commission'),
              'fc_filled_gaps': ('forest_cover', 'commission')}
    for pred, (layer, kind) in checks.items():
        pairs = [(r['answers'][pred], r['truth'][layer][kind]) for r in rows if pred in r['answers']
                 and r['truth'][layer]['pred_px' if kind == 'commission' else 'ref_px'] > 50]
        if not pairs:
            continue
        x, t = np.array(pairs).T
        for cut in (0.2, 0.4):
            y = t >= cut
            if 0 < y.sum() < len(y):
                print(f'{pred:28s} vs {layer} {kind} >= {cut:.0%}: AUC {roc_auc_score(y, x):.2f} (n={len(y)}, positive={y.sum()})')
