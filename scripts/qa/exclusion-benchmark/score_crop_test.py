"""Run the 'icl' Decisions questions on the 20 labeled test crops and score them.

Truth is the reviewer's yes/no per question from crop-labels.sqlite3. Reports per
question the agreement at a 0.5 threshold and the AUC where both answers occur.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sqlite3

import numpy as np
from sklearn.metrics import roc_auc_score

from decisions_crops import PREDICATES, body, load_images, post, read_key

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--run', type=Path, required=True)
    p.add_argument('--key-file', type=Path, required=True)
    p.add_argument('--predicates', default='icl')
    a = p.parse_args()
    crops = json.loads((a.root / 'crop-test.json').read_text())
    labels = {r[0]: json.loads(r[1]) for r in sqlite3.connect(a.root / 'crop-labels.sqlite3').execute(
        'SELECT crop_id, payload FROM labels')}
    key = read_key(a.key_file)
    a.run.mkdir(parents=True, exist_ok=True)

    def one(c):
        out = a.run / f"{c['id']}.json"
        if out.exists():
            return json.loads(out.read_text())
        if c.get('prefix'):
            from decisions_patches import images
            imgs, view = images(a.root / c['prefix']), {'mpp': c['mpp']}
        else:
            evidence = json.loads((a.root / 'datasets' / str(c['dataset_id']) / 'evidence.json').read_text())
            view = next(v for v in evidence['views'] if v['name'] == c['view'])
            imgs = load_images(a.root, c['dataset_id'], view)
        raw = post(body(imgs, view, PREDICATES[a.predicates]), key, 100)
        r = {'crop': c['id'], 'answers': {x['name']: x.get('probability') for x in raw.get('answers', [])
                                          if x.get('type') == 'predicate'}}
        out.write_text(json.dumps(r))
        return r

    with ThreadPoolExecutor(8) as pool:
        model = {r['crop']: r['answers'] for r in pool.map(one, crops)}
    def summarize(batch):
        out = {}
        for q in PREDICATES[a.predicates]:
            pairs = [(model[c['id']].get(q), labels[c['id']]['answers'][q]) for c in batch
                     if c['id'] in labels and labels[c['id']]['answers'].get(q) in (True, False) and model[c['id']].get(q) is not None]
            if not pairs:
                continue
            x = np.array([p for p, _ in pairs]); y = np.array([t for _, t in pairs])
            entry = {'n': len(y), 'yes': int(y.sum()), 'agreement': round(float(((x >= .5) == y).mean()), 2),
                     'model_yes': int((x >= .5).sum())}
            if 0 < y.sum() < len(y):
                entry['auc'] = round(float(roc_auc_score(y, x)), 2)
            out[q] = entry
        return out

    report = {name: summarize(batch) for name, batch in (
        ('all', crops), ('first 20', [c for c in crops if c.get('batch', 1) == 1]),
        ('simpler 10', [c for c in crops if c.get('batch') == 2]))}
    (a.run / 'scores.json').write_text(json.dumps(report, indent=1) + '\n')
    for name, rows in report.items():
        print('==', name)
        for q, e in rows.items():
            print(f"{q:22s} n={e['n']:2d} you-yes={e['yes']:2d} model-yes={e['model_yes']:2d} "
                  f"agreement={e['agreement']:.0%} AUC={e.get('auc', '-')}")
