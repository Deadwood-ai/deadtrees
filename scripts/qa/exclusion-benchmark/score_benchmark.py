"""Score a Sol issue-finder run against the original audits (truth chosen on 8 Oct).

Truth per layer: audit grade bad -> exclude; great or OK -> keep. Failure modes come
from the auditors' notes, mapped to the labeling taxonomy, with a few hand corrections
where the keyword tagger misread a note.
"""
import argparse
from collections import Counter, defaultdict
import csv
import json
from pathlib import Path

LAYERS = ('deadwood', 'forest_cover')
NOTE_TO_MODE = {
    'deadwood': {'omission': 'omission', 'disturbance': 'omission', 'shadow': 'shadow',
                 'confuser_ground': 'commission_ground', 'confuser_vegetation': 'commission_vegetation',
                 'confuser_snow_water': 'commission_snow_water', 'phenology': 'phenology'},
    'forest_cover': {'missing_layer': 'missing_or_partial_layer', 'coverage_gap': 'coverage_processing',
                     'omission': 'omission', 'commission': 'commission'},
}
# Read from the auditors' notes where the keyword tagger was wrong or silent.
OVERRIDES = {
    (7988, 'deadwood'): ['commission_vegetation'],   # dark-leaved live crowns marked dead
    (12279, 'deadwood'): ['coverage_processing'],    # tiling
    (7972, 'deadwood'): ['commission_ground'],       # a cable marked dead
    (11171, 'deadwood'): ['commission_vegetation'],  # the only deadwood polygon is a live tree
    (7339, 'deadwood'): ['omission'],                # countless dead trees not detected
    (5637, 'deadwood'): ['omission'],                # many trees missed, seen by their shadows
    (8078, 'forest_cover'): ['omission'],            # shrub-tree sections missed
    (219, 'forest_cover'): ['commission'],           # patchy, contains non-tree areas
    (5936, 'forest_cover'): ['omission'],            # didn't get all
    (11219, 'forest_cover'): ['inconsistent'],       # inconsistent tree segmentation
}


def adjudicated(root):
    """Janusch's adjudications (8 Oct) override the audit for the layers he checked."""
    import sqlite3
    path = Path(root) / 'labels.sqlite3'
    queue_path = Path(root) / 'adjudication.json'
    if not path.exists() or not queue_path.exists():
        return {}
    queue = json.loads(queue_path.read_text())['datasets']
    out = {}
    for dataset_id, payload in sqlite3.connect(path).execute('SELECT dataset_id, payload FROM labels'):
        for layer, item in json.loads(payload)['layers'].items():
            if layer in queue.get(str(dataset_id), []) and item['verdict'] in ('keep', 'exclude'):
                out[(dataset_id, layer)] = item['verdict'] == 'exclude'
    return out


def truth(dataset, overrides=None):
    out = {}
    for layer in LAYERS:
        bad = dataset[layer + '_quality'] == 'bad'
        modes = OVERRIDES.get((dataset['dataset_id'], layer))
        if modes is None and bad:
            modes = sorted({NOTE_TO_MODE[layer][t] for t in dataset['tags'].get(layer, []) if t in NOTE_TO_MODE[layer]})
        source = 'audit'
        if overrides and (dataset['dataset_id'], layer) in overrides:
            bad, source = overrides[(dataset['dataset_id'], layer)], 'adjudicated'
        out[layer] = {'source': source, 'exclude': bad, 'modes': (modes or ['unspecified']) if bad else [],
                      'grade': dataset[layer + '_quality'], 'note': dataset[layer + '_notes']}
    return out


def score(root, run, split='all'):
    selection = json.loads((root / 'selection.json').read_text())['datasets']
    if split != 'all':
        ids = set(json.loads((root / 'splits.json').read_text())[split])
        selection = [d for d in selection if d['dataset_id'] in ids]
    rows, missing = [], []
    overrides = adjudicated(root)
    for d in selection:
        path = run / 'datasets' / str(d['dataset_id']) / 'result.json'
        if not path.exists():
            missing.append(d['dataset_id'])
            continue
        answer = json.loads(path.read_text())['answer']
        t = truth(d, overrides)
        for layer in LAYERS:
            a = answer['layers'][layer]
            rows.append({'truth_source': t[layer]['source'], 'dataset_id': d['dataset_id'], 'layer': layer, 'role': d['role'],
                         'audit': t[layer]['grade'], 'truth': 'exclude' if t[layer]['exclude'] else 'keep',
                         'modes': ','.join(t[layer]['modes']), 'sol': a['decision'], 'sol_area': a['unacceptable_area'],
                         'sol_modes': ','.join(sorted({i['mode'] for i in a['issues'] if i['severity'] == 'major'})),
                         'sol_confidence': a['confidence'], 'audit_note': (t[layer]['note'] or '')[:160],
                         'sol_reason': a['reason'][:300]})
    summary = {'split': split, 'datasets_scored': len({r['dataset_id'] for r in rows}), 'missing_results': missing, 'layers': {}}
    for layer in LAYERS:
        rs = [r for r in rows if r['layer'] == layer]
        bad = [r for r in rs if r['truth'] == 'exclude']
        good = [r for r in rs if r['truth'] == 'keep']
        c = lambda group, value: sum(1 for r in group if r['sol'] == value)
        by_mode = defaultdict(Counter)
        for r in bad:
            for m in r['modes'].split(','):
                by_mode[m][r['sol']] += 1
        summary['layers'][layer] = {
            'audited_bad': len(bad), 'audited_good': len(good),
            'bad_to_exclude': c(bad, 'exclude'), 'bad_to_unsure': c(bad, 'unsure'), 'bad_to_keep': c(bad, 'keep'),
            'good_to_exclude': c(good, 'exclude'), 'good_to_unsure': c(good, 'unsure'), 'good_to_keep': c(good, 'keep'),
            'exclusion_recall': round(c(bad, 'exclude') / max(1, len(bad)), 3),
            'exclusion_recall_if_unsure_excludes': round((c(bad, 'exclude') + c(bad, 'unsure')) / max(1, len(bad)), 3),
            'false_exclusion_rate': round(c(good, 'exclude') / max(1, len(good)), 3),
            'false_exclusion_rate_if_unsure_excludes': round((c(good, 'exclude') + c(good, 'unsure')) / max(1, len(good)), 3),
            'hard_negatives_excluded': sum(1 for r in good if r['role'] == 'hard_negative' and r['sol'] == 'exclude'),
            'by_failure_mode': {m: dict(v) for m, v in sorted(by_mode.items())},
        }
    return summary, rows


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--run', type=Path, required=True)
    p.add_argument('--split', choices=('all', 'development', 'validation'), default='all')
    a = p.parse_args()
    summary, rows = score(a.root, a.run, a.split)
    (a.run / f'scores-{a.split}.json').write_text(json.dumps(summary, indent=2) + '\n')
    with (a.run / f'scores-{a.split}.csv').open('w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(json.dumps(summary, indent=2))
