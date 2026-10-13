"""Compare every crop-level signal for the per-layer "major" verdict on the gold set.

Truth: the reviewer's v_deadwood / v_forest (major vs OK or minor), crops that can be judged.
Signals come from cached runs only (no model calls): Decisions answers, Sol and Luna verdict
likelihoods, Sol sizes, and combinations. For each signal and layer: AUC (all crops and the
held-out half) and how many other crops get flagged when every major crop is caught.
Cascades: a cheap signal keeps the top share of crops, an expensive one ranks only those.
"""
import argparse
import json
from pathlib import Path
import sqlite3

import numpy as np
from scipy.stats import rankdata
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

LAYERS = {
    'deadwood': ('v_deadwood', ['m1_dead_missed', 'm2_dw_on_live_vegetation', 'm3_dw_on_non_vegetation',
                                'm4_dw_on_lying_wood', 'm7_dw_artifact'], 'dw'),
    'forest': ('v_forest', ['m5_fc_trees_missed', 'm6_fc_on_non_trees', 'm8_dead_not_forest', 'm7_fc_artifact'], 'fc'),
}
SIZE_MODES = {'deadwood': ['m1_dead_missed', 'm2_dw_on_live_vegetation', 'm3_dw_on_non_vegetation', 'm4_dw_on_lying_wood', 'm7_artifact'],
              'forest': ['m5_fc_trees_missed', 'm6_fc_on_non_trees', 'm8_dead_not_forest', 'm7_artifact']}


def load(run, field):
    out = {}
    for f in run.glob('*.json'):
        if f.name != 'scores.json':
            r = json.loads(f.read_text())
            out[r['crop']] = r[field]
    return out


def rank(x):
    return rankdata(x) / len(x)


def flags_at_full_recall(y, score):
    t = score[y].min()
    return int(((score >= t) & ~y).sum())


def loo_logistic(X, y):
    """Leave-one-out predictions of a strongly regularised logistic regression."""
    out = np.zeros(len(y))
    for i in range(len(y)):
        m = np.ones(len(y), bool); m[i] = False
        model = LogisticRegression(C=0.3, class_weight='balanced', max_iter=1000).fit(X[m], y[m])
        out[i] = model.predict_proba(X[i:i + 1])[0, 1]
    return out


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--verdict-runs', nargs='*', default=['sol-verdicts-v1', 'sol-verdicts-medium', 'luna-verdicts-medium'])
    a = p.parse_args()
    runs = a.root / 'runs'
    crops = {c['id']: c for c in json.loads((a.root / 'gold-test.json').read_text())}
    labels = {r[0]: json.loads(r[1])['answers'] for r in sqlite3.connect(a.root / 'gold-labels.sqlite3').execute(
        'SELECT crop_id, payload FROM labels')}
    dec = load(runs / 'decisions-gold9-strict-loc', 'answers')
    major1 = load(runs / 'decisions-major1-strict-loc', 'answers')
    sizes = load(runs / 'sol-sizes-v1', 'estimate')
    verdicts = {name: load(runs / name, 'result') for name in a.verdict_runs if (runs / name).exists()}
    for layer, (vkey, modes, prefix) in LAYERS.items():
        ids = [c for c, l in labels.items() if l.get('m0_assessable') is not False and l.get(vkey) in ('ok', 'minor', 'major')
               and c in dec and c in major1 and all(c in v for v in verdicts.values())]
        y = np.array([labels[c][vkey] == 'major' for c in ids])
        hold = np.array([crops[c]['split'] == 'holdout' for c in ids])
        sig = {}
        sig['dec: verdict question'] = np.array([dec[c].get(vkey) or 0 for c in ids])
        sig['dec: error modes summed'] = np.array([sum(dec[c].get(k) or 0 for k in modes) for c in ids])
        for q in ('major_bias', 'major_fifth', 'major_reviewer'):
            sig[f'dec: {q}'] = np.array([major1[c].get(f'{prefix}_{q}') or 0 for c in ids])
        sig['dec: major wordings mean'] = np.mean([sig[f'dec: {q}'] for q in ('major_bias', 'major_fifth', 'major_reviewer')], axis=0)
        X = np.column_stack([np.array([dec[c].get(k) or 0 for c in ids]) for k in modes + [vkey]]
                            + [sig[f'dec: {q}'] for q in ('major_bias', 'major_fifth', 'major_reviewer')])
        sig['dec: learned mix (LOO)'] = loo_logistic(X, y)
        in_sizes = np.array([c in sizes for c in ids])
        sig['sol sizes summed'] = np.array([sum(sizes[c].get(k, 0) for k in SIZE_MODES[layer]) if c in sizes else 0 for c in ids])
        for name, v in verdicts.items():
            sig[name] = np.array([v[c][layer]['major_likelihood'] for c in ids])
        if 'sol-verdicts-v1' in verdicts:
            sig['sol high verdict + sol sizes'] = rank(sig['sol-verdicts-v1']) + rank(sig['sol sizes summed'])
        print(f'\n== {layer}: {len(ids)} crops, {y.sum()} major ({(y & hold).sum()} in holdout)')
        for name, s in sig.items():
            print(f'  {name:34s} AUC {roc_auc_score(y, s):.2f}  holdout {roc_auc_score(y[hold], s[hold]):.2f}  '
                  f'catch all -> {flags_at_full_recall(y, s):3d}/{(~y).sum()} others flagged')
        # Cascades: keep the top share by a cheap signal, rank the kept crops by an expensive one.
        for cheap in ('dec: major wordings mean', 'dec: learned mix (LOO)', 'dec: error modes summed'):
            for costly in [n for n in verdicts] + ['sol high verdict + sol sizes']:
                if costly not in sig:
                    continue
                for share in (0.2, 0.35, 0.5):
                    keep = sig[cheap] >= np.quantile(sig[cheap], 1 - share)
                    final = np.where(keep, 1 + rank(sig[costly]), rank(sig[cheap]) * 0)
                    passed = int((keep & y).sum())
                    print(f'  cascade {cheap} top {share:.0%} -> {costly}: {passed}/{y.sum()} major kept, '
                          f'AUC {roc_auc_score(y, final):.2f}, catch kept -> '
                          f'{int(((final >= final[y & keep].min()) & ~y).sum()) if passed else "-"} flagged')
