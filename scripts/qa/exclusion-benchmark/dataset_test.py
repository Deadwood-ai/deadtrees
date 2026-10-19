"""Dataset-level test: do crop verdicts aggregate into the audit's keep/exclude per layer?

`--prepare` lists the benchmark crops (bench-crops/<dataset>-<n>, from gold_crops.py
--datasets) as bench-test.json, so sol_verdicts.py can run on them with --crops-file.
Without it, scores aggregation rules against the audit truth (score_benchmark.truth, with
Janusch's adjudications) on the development and validation splits. Crop score = Luna and
Haiku major likelihood averaged; a crop is major above the per-layer cut-off calibrated on
the gold crops. Rules: at least k major crops, an area-weighted share of major crops, and
the mean likelihood. Target: catch >= 90% of Bad layers, wrongly exclude <= 20% of good.
"""
import argparse
import json
from pathlib import Path

import numpy as np

from score_benchmark import adjudicated, truth

LAYERS = {'deadwood': 'deadwood', 'forest_cover': 'forest'}  # benchmark layer -> verdict layer
CUTS = {'deadwood': 52, 'forest': 69}  # calibrated on the gold crops, 13 Oct
TARGET_RECALL, TARGET_FALSE = 0.9, 0.2


def prepare(root, folder, out, prefix):
    """List the cut crops of one sampling method; a sampler's picks.json adds each crop's area weight."""
    splits = json.loads((root / 'splits.json').read_text())
    split_of = {i: name for name in ('development', 'validation') for i in splits[name]}
    picks = json.loads((root / folder / 'picks.json').read_text()) if (root / folder / 'picks.json').exists() else {}
    crops = []
    for d in sorted((root / folder).iterdir()):
        if not (d / 'truth.json').exists():
            continue
        t = json.loads((d / 'truth.json').read_text())
        dataset, n = d.name.rsplit('-', 1)
        picked = picks.get(dataset, {}).get('crops', [])
        crops.append({'id': f'{prefix}-{d.name}', 'dataset_id': t['dataset_id'], 'view': t['strategy'], 'mpp': t['mpp'],
                      'prefix': f'{folder}/{d.name}/', 'source': 'benchmark dataset',
                      'split': split_of.get(t['dataset_id'], 'other'), 'predicted_fraction': t['predicted_fraction'],
                      'weight': picked[int(n) - 1]['weight'] if len(picked) >= int(n) else None})
    (root / out).write_text(json.dumps(crops, indent=1))
    print(f'{len(crops)} crops from {len({c["dataset_id"] for c in crops})} datasets')


def load(run):
    return {json.loads(f.read_text())['crop']: json.loads(f.read_text())['result']
            for f in run.glob('*.json') if f.name != 'scores.json'}


def rates(rows, flag):
    bad = [r for r in rows if r['bad']]; good = [r for r in rows if not r['bad']]
    caught = sum(flag(r) for r in bad); false = sum(flag(r) for r in good)
    return caught, len(bad), false, len(good)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--prepare', action='store_true')
    p.add_argument('--runs', nargs=2, default=['luna-bench-v4', 'haiku-bench-v4'])
    p.add_argument('--crops-dir', default='bench-crops', help='bench-crops (fixed 10) or sampled-crops (crop_sampler.py)')
    p.add_argument('--crops-file', default='bench-test.json')
    p.add_argument('--id-prefix', default='bench')
    a = p.parse_args()
    if a.prepare:
        prepare(a.root, a.crops_dir, a.crops_file, a.id_prefix)
        raise SystemExit
    crops = json.loads((a.root / a.crops_file).read_text())
    selection = {d['dataset_id']: d for d in json.loads((a.root / 'selection.json').read_text())['datasets']}
    overrides = adjudicated(a.root)
    runs = [load(a.root / 'runs' / r) for r in a.runs]
    rows = []
    for dataset_id in sorted({c['dataset_id'] for c in crops}):
        mine = [c for c in crops if c['dataset_id'] == dataset_id and all(c['id'] in r for r in runs)]
        if not mine or dataset_id not in selection:
            continue
        t = truth(selection[dataset_id], overrides)
        for layer, vlayer in LAYERS.items():
            lik = np.array([np.mean([r[c['id']][vlayer]['major_likelihood'] for r in runs]) for c in mine])
            area = np.array([c['predicted_fraction'][layer] for c in mine])
            weight = np.array([c.get('weight') or 1 / len(mine) for c in mine]); weight /= weight.sum()
            major = lik >= CUTS[vlayer]
            rows.append({'dataset_id': dataset_id, 'layer': layer, 'split': mine[0]['split'], 'bad': t[layer]['exclude'],
                         'grade': t[layer]['grade'], 'n': len(mine), 'major': int(major.sum()), 'share': float((major * weight).sum()),
                         'area_share': float((major * area).sum() / area.sum()) if area.sum() > 0 else 0.0,
                         'mean': float(lik.mean())})
    (a.root / 'runs' / f'dataset-test-{a.id_prefix}.json').write_text(json.dumps(rows, indent=1))
    rules = {f'>= {k} major crops': (lambda k: lambda r: r['major'] >= k)(k) for k in (1, 2, 3, 4)}
    rules |= {f'weighted share >= {s:.0%}': (lambda s: lambda r: r['share'] >= s)(s) for s in (0.1, 0.2, 0.3)}
    rules |= {f'area share >= {s:.0%}': (lambda s: lambda r: r['area_share'] >= s)(s) for s in (0.1, 0.2, 0.3)}
    rules |= {f'mean likelihood >= {m}': (lambda m: lambda r: r['mean'] >= m)(m) for m in (30, 40, 50)}
    for layer in LAYERS:
        print(f'\n== {layer}')
        for name, rule in rules.items():
            cells = []
            for split in ('development', 'validation'):
                c, b, f, g = rates([r for r in rows if r['layer'] == layer and r['split'] == split], rule)
                cells.append(f'{split[:3]} Bad {c}/{b}, good wrongly {f}/{g}')
            c, b, f, g = rates([r for r in rows if r['layer'] == layer], rule)
            ok = b and c / b >= TARGET_RECALL and g and f / g <= TARGET_FALSE
            print(f'  {name:24s} all: Bad {c}/{b}, good wrongly {f}/{g}{"  <- meets target" if ok else ""} | ' + ' | '.join(cells))
