"""Sol gives the per-layer verdict (OK / minor / major) on the gold crops, as the reviewer does.

Same images and rules as sol_sizes.py. Per layer Sol names the errors it sees, gives the
verdict for the satellite product and a 0-100 likelihood that the layer has a major error
(used for ranking). Scored against the reviewer's verdicts: AUC for major vs the rest, and
the verdict confusion table.
"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import re
import sqlite3
import time

import numpy as np
from sklearn.metrics import roc_auc_score

from analyst import analyst
from magnitude_llm import jpeg
from model_transport import invoke
from score_gold import crop_images
from sol_issue_finder import NoTools

LAYERS = {'deadwood': 'v_deadwood', 'forest': 'v_forest'}
VERDICTS = ('ok', 'minor', 'major')
PROMPT = '''Aerial drone image crop, about 51 m by 51 m at about 5 cm per pixel. Image 1 is raw RGB,
Image 2 the DEADWOOD prediction (blue fill with outline), Image 3 the FOREST prediction (gold).
Darkened areas are outside the area of interest; ignore them.

Rules: deadwood means standing dead trees and dead parts of standing trees (grey, white, brown
or burnt crowns and branches); lying trunks, logs and debris are never deadwood. Forest means
all tree canopy, including standing dead trees; grass, crops, low shrubs and open gaps between
crowns are not forest.

The predictions feed a satellite product that maps deadwood cover and forest cover per 10 m
pixel; this crop is 5 x 5 such pixels. Judge each layer separately. Compare the overlay with the
raw image region by region, list the errors you see, then give the verdict for that layer:
- "ok": no relevant error.
- "minor": errors exist, but together they would not noticeably change the satellite cover here.
- "major": all errors in this layer together would noticeably bias the satellite cover here, so
  this layer should be excluded.
Count overlapping errors once. Also give major_likelihood, 0 to 100, that the layer has a major error.

Return only JSON: {"assessable": true|false,
 "deadwood": {"errors": ["..."], "verdict": "ok|minor|major", "major_likelihood": n},
 "forest": {"errors": ["..."], "verdict": "ok|minor|major", "major_likelihood": n}}'''


def ask(root, crop, out):
    out.mkdir(parents=True, exist_ok=True)
    named = [(str(i + 1), jpeg(im)) for i, im in enumerate(crop_images(root, crop))]
    for attempt in range(1, 5):
        try:
            text, receipt = invoke(PROMPT, named, out, 'gpt-6.1-sol', 'high', NoTools())
            values = json.loads(re.search(r'\{.*\}', text, re.S).group(0))
            result = {'assessable': bool(values.get('assessable', True))}
            for layer in LAYERS:
                v = values[layer]
                if v['verdict'] not in VERDICTS:
                    raise ValueError('bad verdict')
                result[layer] = {'verdict': v['verdict'], 'major_likelihood': float(v['major_likelihood']),
                                 'errors': [str(e)[:200] for e in v.get('errors', [])][:10]}
            return result, receipt.get('usage')
        except ValueError as e:
            if not any(t in str(e) for t in ('serverOverloaded', 'at capacity', 'stream disconnected')) or attempt == 4:
                raise
            time.sleep(60 * attempt)


def score(crops, labels, sol):
    out = {}
    for layer, key in LAYERS.items():
        rows = [(sol[c['id']][layer], labels[c['id']]['answers'][key]) for c in crops
                if c['id'] in sol and c['id'] in labels and labels[c['id']]['answers'].get('m0_assessable') is not False
                and labels[c['id']]['answers'].get(key) in VERDICTS]
        if not rows:
            continue
        y = np.array([t == 'major' for _, t in rows]); x = np.array([s['major_likelihood'] for s, _ in rows])
        entry = {'n': len(rows), 'major': int(y.sum()),
                 'confusion': dict(Counter(f"you {t} / sol {s['verdict']}" for s, t in rows))}
        if 0 < y.sum() < len(y):
            entry['auc_major'] = round(float(roc_auc_score(y, x)), 2)
        out[layer] = entry
    return out


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--run', type=Path, required=True)
    p.add_argument('--limit', type=int)
    p.add_argument('--workers', type=int, default=4)
    a = p.parse_args()
    crops = json.loads((a.root / 'gold-test.json').read_text())
    labels = {r[0]: json.loads(r[1]) for r in sqlite3.connect(a.root / 'gold-labels.sqlite3').execute(
        'SELECT crop_id, payload FROM labels')}
    # Only datasets that are still public and unarchived may be sent.
    with analyst() as db:
        eligible = {r['id'] for r in db.execute("SELECT id FROM v2_datasets WHERE id = ANY(%s) AND data_access = 'public' "
                                                "AND NOT archived", (list({c['dataset_id'] for c in crops}),)).fetchall()}
    crops = [c for c in crops if c['dataset_id'] in eligible][:a.limit]
    a.run.mkdir(parents=True, exist_ok=True)

    def one(c):
        path = a.run / f"{c['id']}.json"
        if path.exists():
            return json.loads(path.read_text())
        try:
            result, usage = ask(a.root, c, a.run / 'trials' / c['id'])
        except Exception as e:
            print(c['id'], type(e).__name__, str(e)[:200], flush=True)
            return None
        r = {'crop': c['id'], 'result': result, 'usage': usage}
        path.write_text(json.dumps(r))
        return r

    with ThreadPoolExecutor(a.workers) as pool:
        sol = {r['crop']: r['result'] for r in pool.map(one, crops) if r}
    report = {name: score([c for c in crops if name == 'all' or c['split'] == name], labels, sol)
              for name in ('all', 'tune', 'holdout')}
    (a.run / 'scores.json').write_text(json.dumps(report, indent=1) + '\n')
    for name, layers in report.items():
        for layer, e in layers.items():
            print(f"{name:8s} {layer:9s} n={e['n']} major={e['major']} AUC={e.get('auc_major', '-')} {e['confusion']}")
