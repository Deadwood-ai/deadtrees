"""Freeze a small development split for prompt iteration; the rest is held for validation.

Chosen from selection metadata only (roles, audited layers, failure modes), never from
model results, with a stable hash order inside each stratum.
"""
import argparse
import hashlib
import json
from pathlib import Path

from score_benchmark import truth


def key(dataset_id):
    return hashlib.sha256(f'exclusion-dev-v1:{dataset_id}'.encode()).hexdigest()


def split(datasets, rendered, per_role):
    pool = sorted((d for d in datasets if d['dataset_id'] in rendered), key=lambda d: key(d['dataset_id']))
    dev, seen = [], set()
    # Cover each audited failure mode once, then fill each role to its quota.
    for d in pool:
        if d['role'] != 'audited_bad':
            continue
        t = truth(d)
        modes = {(l, m) for l in t for m in t[l]['modes']}
        if modes - seen:
            dev.append(d)
            seen |= modes
    for role, quota in per_role.items():
        for d in pool:
            if sum(1 for x in dev if x['role'] == role) >= quota:
                break
            if d['role'] == role and d not in dev:
                dev.append(d)
    ids = {d['dataset_id'] for d in dev}
    return sorted(ids), sorted(d['dataset_id'] for d in pool if d['dataset_id'] not in ids)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    a = p.parse_args()
    datasets = json.loads((a.root / 'selection.json').read_text())['datasets']
    rendered = {int(p.parent.name) for p in (a.root / 'datasets').glob('*/evidence.json')}
    dev, validation = split(datasets, rendered, {'audited_bad': 12, 'hard_negative': 4, 'diverse_keep': 2})
    (a.root / 'splits.json').write_text(json.dumps({'development': dev, 'validation': validation,
        'rule': 'Metadata-only: one audited-bad dataset per uncovered failure mode, then role quotas; stable hash order.'},
        indent=2) + '\n')
    print({'development': len(dev), 'validation': len(validation)})
