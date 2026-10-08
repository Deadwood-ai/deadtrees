"""Calibrate an exclusion cutoff on Sol's measured error shares and log the iteration.

Target (agreed 8 Oct): catch >=90% of audited-Bad layers while wrongly excluding <=20%
of audited Great/OK layers. Cutoffs are chosen on the development split only.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path

from score_benchmark import LAYERS, adjudicated, truth

TARGET_RECALL, TARGET_FALSE = 0.9, 0.2


def load(root, run, split):
    selection = {d['dataset_id']: d for d in json.loads((root / 'selection.json').read_text())['datasets']}
    ids = json.loads((root / 'splits.json').read_text())[split] if split != 'all' else list(selection)
    rows, overrides = [], adjudicated(root)
    for i in ids:
        path = run / 'datasets' / str(i) / 'result.json'
        if not path.exists():
            continue
        answer = json.loads(path.read_text())['answer']
        t = truth(selection[i], overrides)
        for layer in LAYERS:
            a = answer['layers'][layer]
            rows.append({'dataset_id': i, 'layer': layer, 'bad': t[layer]['exclude'], 'decision': a['decision'],
                         'grade': a.get('auditor_grade'), 'commission': float(a.get('commission_pct', 'nan')),
                         'omission': float(a.get('omission_pct', 'nan'))})
    return rows


def rates(rows, flag):
    bad = [r for r in rows if r['bad']]
    good = [r for r in rows if not r['bad']]
    recall = sum(map(flag, bad)) / max(1, len(bad))
    false = sum(map(flag, good)) / max(1, len(good))
    return round(recall, 3), round(false, 3), len(bad), len(good)


def sweep(rows):
    """Best single-threshold rule per layer: max(commission, omission) >= t."""
    best = None
    for t in range(0, 101, 5):
        recall, false, *_ = rates(rows, lambda r: max(r['commission'], r['omission']) >= t)
        meets = recall >= TARGET_RECALL
        key = (meets, -false if meets else recall, t)
        if best is None or key > best[0]:
            best = (key, {'threshold': t, 'recall': recall, 'false_exclusion': false})
    return best[1]


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--run', type=Path, required=True)
    p.add_argument('--split', default='development')
    p.add_argument('--note', default='')
    a = p.parse_args()
    rows = load(a.root, a.run, a.split)
    report = {'run': a.run.name, 'split': a.split, 'at': datetime.now(timezone.utc).isoformat(), 'note': a.note,
              'layers': {}}
    for layer in LAYERS:
        rs = [r for r in rows if r['layer'] == layer]
        recall, false, n_bad, n_good = rates(rs, lambda r: r['decision'] == 'exclude')
        entry = {'bad': n_bad, 'good': n_good, 'decision': {'recall': recall, 'false_exclusion': false}}
        if any(r['grade'] for r in rs):
            entry['grade_bad'] = dict(zip(('recall', 'false_exclusion'), rates(rs, lambda r: r['grade'] == 'bad')[:2]))
            entry['grade_ok_or_bad'] = dict(zip(('recall', 'false_exclusion'),
                                                rates(rs, lambda r: r['grade'] in ('ok', 'bad'))[:2]))
            entry['share_cutoff'] = sweep(rs)
        report['layers'][layer] = entry
    with (a.root / 'iterations.jsonl').open('a') as f:
        f.write(json.dumps(report) + '\n')
    print(json.dumps(report, indent=2))
