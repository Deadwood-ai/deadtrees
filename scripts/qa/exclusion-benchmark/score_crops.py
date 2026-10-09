"""Score per-crop failure-mode answers against the dataset truth (audits + adjudications).

For every predicate: aggregate crop probabilities per dataset (max, mean, share of crops
above 0.5) and report the AUC against that layer's exclude label. Also reports how often
each mode fires on audited-Bad vs good datasets, and the audited failure modes it hits.
"""
import argparse
from collections import defaultdict
import json
from pathlib import Path

import numpy as np
from sklearn.metrics import roc_auc_score

from score_benchmark import adjudicated, truth


def load(run):
    data = defaultdict(dict)
    for f in run.glob('*/*.json'):
        r = json.loads(f.read_text())
        if 'answers' in r:
            data[r['dataset_id']][r['view']] = r['answers']
    return data


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--run', type=Path, required=True)
    a = p.parse_args()
    selection = {d['dataset_id']: d for d in json.loads((a.root / 'selection.json').read_text())['datasets']}
    overrides = adjudicated(a.root)
    data = load(a.run)
    predicates = sorted({k for crops in data.values() for answers in crops.values() for k in answers})
    report = {'run': a.run.name, 'datasets': len(data), 'predicates': {}}
    for pred in predicates:
        layer = 'deadwood' if pred.startswith('dw_') else 'forest_cover'
        ids = [i for i in data if i in selection]
        y = np.array([truth(selection[i], overrides)[layer]['exclude'] for i in ids])
        vals = [np.array([c.get(pred) or 0 for c in data[i].values()]) for i in ids]
        agg = {'max': np.array([v.max() for v in vals]), 'mean': np.array([v.mean() for v in vals]),
               'share': np.array([(v > .5).mean() for v in vals])}
        entry = {'layer': layer, 'auc': {k: round(float(roc_auc_score(y, v)), 2) for k, v in agg.items()},
                 'fires_on_bad': round(float((agg['share'][y] > 0).mean()), 2),
                 'fires_on_good': round(float((agg['share'][~y] > 0).mean()), 2)}
        modes = defaultdict(list)
        for i, s in zip(ids, agg['share']):
            t = truth(selection[i], overrides)[layer]
            for m in t['modes']:
                modes[m].append(bool(s > 0))
        entry['hits_by_audited_mode'] = {m: f'{sum(v)}/{len(v)}' for m, v in sorted(modes.items())}
        report['predicates'][pred] = entry
    (a.run / 'scores.json').write_text(json.dumps(report, indent=1) + '\n')
    for pred, e in report['predicates'].items():
        print(f"{pred:30s} AUC max {e['auc']['max']:.2f} mean {e['auc']['mean']:.2f} share {e['auc']['share']:.2f} | "
              f"fires bad {e['fires_on_bad']:.0%} good {e['fires_on_good']:.0%} | {e['hits_by_audited_mode']}")
