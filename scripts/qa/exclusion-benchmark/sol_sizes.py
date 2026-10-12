"""Sol sizes each failure mode on the gold crops; scored against the reviewer's yes/no and sizes.

Sol (high) gets the raw crop and both overlays and returns, per mode, the affected share of
the layer in percent, using the same definitions as the size keys on the labeling page.
Scoring per mode: AUC of Sol's percentage against the reviewer's yes/no, caught and false
alarms at 10% and 20%, and for yes answers with a size, how often Sol's size step matches
(exactly and within one step). Crops the reviewer could not judge are left out.
"""
import argparse
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

MODES = {  # mode -> what the percentage is a share of (same wording as the labeling page)
    'm1_dead_missed': 'share of the standing dead trees and dead crown parts that have no blue',
    'm2_dw_on_live_vegetation': 'share of the blue that lies on living trees, shrubs, grass or crops',
    'm3_dw_on_non_vegetation': 'share of the blue that lies on ground, rock, roads, roofs, water, snow or deep shadow',
    'm4_dw_on_lying_wood': 'share of the blue that lies on lying trunks, logs or debris',
    'm5_fc_trees_missed': 'share of the living tree canopy that has no gold',
    'm6_fc_on_non_trees': 'share of the gold that lies on shrubs, crops, grass, ground, roofs or open gaps between crowns',
    'm7_artifact': 'share of the crop affected by processing artifacts (straight tile seams, rectangular holes or blocks, a layer cut off or missing)',
    'm8_dead_not_forest': 'share of the standing dead trees that have no gold',
}
STEPS = ('<10', '10-20', '20-50', '>50')
PROMPT = '''Aerial drone image crop, about 51 m by 51 m at about 5 cm per pixel. Image 1 is raw RGB,
Image 2 the DEADWOOD prediction (blue fill with outline), Image 3 the FOREST prediction (gold).
Darkened areas are outside the area of interest; ignore them.

Rules: deadwood means standing dead trees and dead parts of standing trees (grey, white, brown
or burnt crowns and branches); lying trunks, logs and debris are never deadwood. Forest means
all tree canopy, including standing dead trees; grass, crops, low shrubs and open gaps between
crowns are not forest.

Compare each overlay with the raw image region by region. For each error type give the
affected area in percent (0 to 100) of the stated reference; 0 if the error is absent or the
reference is absent. Rough is fine.
{modes}

Also say whether the crop can be judged at all (sharp enough, trees or ground clearly visible).
Return only JSON: {{"assessable": true|false, {keys}}}'''


def prompt():
    return PROMPT.format(modes='\n'.join(f'- {k}: {v}' for k, v in MODES.items()),
                         keys=', '.join(f'"{k}": n' for k in MODES))


def step(pct):
    return STEPS[int(np.digitize(pct, [10, 20, 50]))]


def ask(root, crop, out):
    out.mkdir(parents=True, exist_ok=True)
    named = [(str(i + 1), jpeg(im)) for i, im in enumerate(crop_images(root, crop))]
    for attempt in range(1, 5):
        try:
            text, receipt = invoke(prompt(), named, out, 'gpt-6.1-sol', 'high', NoTools())
            values = json.loads(re.search(r'\{.*\}', text, re.S).group(0))
            return {'assessable': bool(values.get('assessable', True)),
                    **{k: float(values[k]) for k in MODES}}, receipt.get('usage')
        except ValueError as e:
            if not any(t in str(e) for t in ('serverOverloaded', 'at capacity', 'stream disconnected')) or attempt == 4:
                raise
            time.sleep(60 * attempt)


def score(crops, labels, sol):
    out = {}
    for k in MODES:
        pairs, sizes = [], []
        for c in crops:
            lab, est = labels.get(c['id']), sol.get(c['id'])
            if not lab or not est or lab['answers'].get('m0_assessable') is False:
                continue
            v = lab['answers'].get(k)
            if v in (True, False):
                pairs.append((est[k], v))
            if v is True and lab.get('sizes', {}).get(k):
                sizes.append((STEPS.index(step(est[k])), STEPS.index(lab['sizes'][k])))
        if not pairs:
            continue
        x = np.array([p for p, _ in pairs]); y = np.array([t for _, t in pairs])
        entry = {'n': len(y), 'yes': int(y.sum())}
        if 0 < y.sum() < len(y):
            entry['auc'] = round(float(roc_auc_score(y, x)), 2)
        for cut in (10, 20):
            entry[f'caught@{cut}'] = int(((x >= cut) & y).sum())
            entry[f'false@{cut}'] = int(((x >= cut) & ~y).sum())
        if sizes:
            s = np.array(sizes)
            entry['sized'] = len(s)
            entry['size_exact'] = int((s[:, 0] == s[:, 1]).sum())
            entry['size_within_one'] = int((abs(s[:, 0] - s[:, 1]) <= 1).sum())
        out[k] = entry
    return out


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--run', type=Path, required=True)
    p.add_argument('--only-labeled', action='store_true')
    p.add_argument('--limit', type=int)
    p.add_argument('--workers', type=int, default=4)
    a = p.parse_args()
    crops = json.loads((a.root / 'gold-test.json').read_text())
    labels = {r[0]: json.loads(r[1]) for r in sqlite3.connect(a.root / 'gold-labels.sqlite3').execute(
        'SELECT crop_id, payload FROM labels')}
    if a.only_labeled:
        crops = [c for c in crops if c['id'] in labels]
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
            estimate, usage = ask(a.root, c, a.run / 'trials' / c['id'])
        except Exception as e:
            print(c['id'], type(e).__name__, str(e)[:200], flush=True)
            return None
        r = {'crop': c['id'], 'estimate': estimate, 'usage': usage}
        path.write_text(json.dumps(r))
        return r

    with ThreadPoolExecutor(a.workers) as pool:
        sol = {r['crop']: r['estimate'] for r in pool.map(one, crops) if r}
    report = {name: score([c for c in crops if name == 'all' or c['split'] == name], labels, sol)
              for name in ('all', 'tune', 'holdout')}
    (a.run / 'scores.json').write_text(json.dumps(report, indent=1) + '\n')
    for k, e in report['all'].items():
        size = f"  size exact {e['size_exact']}/{e['sized']}, within one {e['size_within_one']}" if 'sized' in e else ''
        print(f"{k:26s} AUC {e.get('auc', '-'):>4}  ≥10%: {e['caught@10']}/{e['yes']} caught, {e['false@10']}/{e['n'] - e['yes']} false"
              f"  ≥20%: {e['caught@20']}/{e['yes']}, {e['false@20']} false{size}")
