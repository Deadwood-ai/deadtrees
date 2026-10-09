"""Benchmark Decisions on the gold crop set against the reviewer's labels.

For every labeled crop, ask the gold7 questions (one request per crop, cached per run)
and report per failure mode: reviewer yes/no counts, how many yes cases the model catches
and how many false alarms it raises at several certainty cut-offs, and the AUC. "?" and
blank answers are left out. Results are given for the tune split, the held-out split and
both together. Optional neutral context (biome, month, hemisphere, resolution).
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sqlite3

import numpy as np
from sklearn.metrics import roc_auc_score

from analyst import analyst
from decisions_crops import CONTEXTS, PREDICATES, body, post, read_key
from decisions_patches import images

CUTS = (0.5, 0.7, 0.9)


def neutral_context(dataset_ids):
    with analyst() as db:
        rows = db.execute("SELECT d.id, d.aquisition_month AS month, m.metadata->'biome'->>'biome_name' AS biome, "
                          "ST_Y(ST_Centroid(ST_GeomFromGeoJSON(COALESCE(a.geometry->'geometry', a.geometry)))) AS lat "
                          "FROM v2_datasets d LEFT JOIN v2_metadata m ON m.dataset_id = d.id "
                          "LEFT JOIN LATERAL (SELECT geometry FROM v2_aois WHERE dataset_id = d.id "
                          "ORDER BY created_at DESC, id DESC LIMIT 1) a ON true WHERE d.id = ANY(%s)",
                          (list(dataset_ids),)).fetchall()
    months = 'January February March April May June July August September October November December'.split()
    return {r['id']: (f"Context: biome {r['biome'] or 'unknown'}; "
                      f"{'southern' if (r['lat'] or 0) < 0 else 'northern'} hemisphere; "
                      f"acquired in {months[r['month'] - 1] if r['month'] else 'an unknown month'}.") for r in rows}


def score(crops, labels, model, questions):
    out = {}
    for q in questions:
        pairs = [(model[c['id']].get(q), labels[c['id']][q]) for c in crops
                 if c['id'] in labels and c['id'] in model and labels[c['id']].get(q) in (True, False)
                 and model[c['id']].get(q) is not None]
        if not pairs:
            continue
        x = np.array([p for p, _ in pairs]); y = np.array([t for _, t in pairs])
        entry = {'n': len(y), 'yes': int(y.sum())}
        for cut in CUTS:
            entry[f'caught@{cut}'] = int(((x >= cut) & y).sum())
            entry[f'false@{cut}'] = int(((x >= cut) & ~y).sum())
        if 0 < y.sum() < len(y):
            entry['auc'] = round(float(roc_auc_score(y, x)), 2)
        out[q] = entry
    return out


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--run', type=Path, required=True)
    p.add_argument('--key-file', type=Path, required=True)
    p.add_argument('--context', choices=sorted(CONTEXTS), default='strict')
    p.add_argument('--with-location', action='store_true', help='add neutral biome/month/hemisphere context')
    a = p.parse_args()
    crops = json.loads((a.root / 'gold-test.json').read_text())
    labels = {r[0]: json.loads(r[1])['answers'] for r in sqlite3.connect(a.root / 'gold-labels.sqlite3').execute(
        'SELECT crop_id, payload FROM labels')}
    crops = [c for c in crops if c['id'] in labels]
    questions = PREDICATES['gold7']
    extra = neutral_context({c['dataset_id'] for c in crops}) if a.with_location else {}
    key = read_key(a.key_file)
    a.run.mkdir(parents=True, exist_ok=True)

    def one(c):
        out = a.run / f"{c['id']}.json"
        if out.exists():
            return json.loads(out.read_text())
        context = CONTEXTS[a.context] + ('\n' + extra[c['dataset_id']] if c['dataset_id'] in extra else '')
        raw = post(body(_images(a.root, c), {'mpp': c['mpp']}, questions, context), key, 400)
        r = {'crop': c['id'], 'answers': {x['name']: x.get('probability') for x in raw.get('answers', [])
                                          if x.get('type') == 'predicate'}}
        out.write_text(json.dumps(r))
        return r

    def _images(root, c):
        if c['prefix'].endswith('/'):
            return images(root / c['prefix'])
        from PIL import Image
        from sol_issue_finder import composite
        raw = Image.open(root / (c['prefix'] + 'raw.jpg'))
        return [raw] + [composite(raw, (root / (c['prefix'] + f'{l}-fill.png'), root / (c['prefix'] + f'{l}-outline.png')))
                        for l in ('deadwood', 'forest_cover')]

    with ThreadPoolExecutor(8) as pool:
        model = {r['crop']: r['answers'] for r in pool.map(one, crops)}
    report = {name: score([c for c in crops if name == 'all' or c['split'] == name], labels, model, questions)
              for name in ('all', 'tune', 'holdout')}
    (a.run / 'scores.json').write_text(json.dumps(report, indent=1) + '\n')
    for name, rows in report.items():
        print('==', name)
        for q, e in rows.items():
            cuts = '  '.join(f"≥{c}: {e[f'caught@{c}']}/{e['yes']} caught, {e[f'false@{c}']}/{e['n'] - e['yes']} false" for c in CUTS)
            print(f"{q:26s} AUC {e.get('auc', '-'):>4}  {cuts}")
