"""Baseline: predict audit Bad per layer from prediction statistics and scene embeddings.

Spatially grouped cross-validation (1-degree cells) keeps sites out of their own
training folds. Benchmark datasets are never trained on; they are scored at the end
with a cutoff fixed on the out-of-fold scores, so the result is comparable with Sol.
"""
import argparse
import json
from pathlib import Path

import numpy as np
from sklearn.decomposition import PCA
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold

LAYERS = ('deadwood', 'forest_cover')


def matrix(rows, names, pca):
    base = np.array([[r['features'][n] for n in names] for r in rows], dtype=float)
    if pca is None:
        return base
    emb = np.array([r['embedding'] if r['embedding'] else [0.0] * pca.n_features_in_ for r in rows], dtype=float)
    return np.hstack([base, pca.transform(emb)])


def cutoff_for(scores, labels, max_false=0.2):
    good = np.sort(scores[labels == 0])
    return good[int(np.ceil((1 - max_false) * len(good))) - 1]


def rates(scores, labels, cut):
    flag = scores > cut
    return {'recall': round(float(flag[labels == 1].mean()), 3), 'false_exclusion': round(float(flag[labels == 0].mean()), 3),
            'bad': int(labels.sum()), 'good': int((labels == 0).sum())}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--embeddings', type=int, default=16, help='PCA components of the scene embedding (0 = none)')
    a = p.parse_args()
    rows = json.loads((a.root / 'audit-features.json').read_text())
    bench_ids = {d['dataset_id'] for d in json.loads((a.root / 'selection.json').read_text())['datasets']}
    train = [r for r in rows if r['dataset_id'] not in bench_ids]
    bench = [r for r in rows if r['dataset_id'] in bench_ids]
    names = sorted(train[0]['features'])
    pca = None
    if a.embeddings:
        pca = PCA(a.embeddings, random_state=0).fit(np.array([r['embedding'] for r in train if r['embedding']]))
    X, Xb = matrix(train, names, pca), matrix(bench, names, pca)
    groups = np.array([f"{round(r['lat'])}:{round(r['lon'])}" for r in train])
    report = {'train_audits': len(train), 'benchmark_audits': len(bench), 'embedding_components': a.embeddings, 'layers': {}}
    for layer in LAYERS:
        y = np.array([r[layer + '_bad'] for r in train], dtype=int)
        yb = np.array([r[layer + '_bad'] for r in bench], dtype=int)
        oof = np.zeros(len(y))
        for fit, test in GroupKFold(5).split(X, y, groups):
            model = HistGradientBoostingClassifier(max_iter=300, learning_rate=.05, class_weight='balanced',
                                                   random_state=0).fit(X[fit], y[fit])
            oof[test] = model.predict_proba(X[test])[:, 1]
        cut = cutoff_for(oof, y)
        model = HistGradientBoostingClassifier(max_iter=300, learning_rate=.05, class_weight='balanced',
                                               random_state=0).fit(X, y)
        sb = model.predict_proba(Xb)[:, 1]
        report['layers'][layer] = {'cv_auc': round(float(roc_auc_score(y, oof)), 3),
                                   'cv_at_20pct_false': rates(oof, y, cut),
                                   'benchmark_auc': round(float(roc_auc_score(yb, sb)), 3),
                                   'benchmark_at_cv_cutoff': rates(sb, yb, cut)}
        np.save(a.root / f'classifier-benchmark-{layer}.npy', np.c_[[r['dataset_id'] for r in bench], sb])
    print(json.dumps(report, indent=2))
