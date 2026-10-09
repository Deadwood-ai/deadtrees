"""Assemble the gold crop set: reuse the 40 labeled test crops plus the new gold crops.

Writes gold-test.json (with a frozen tune/holdout split by dataset) and pre-fills
gold-labels.sqlite3 from the earlier answers where the old questions map onto the seven
modes. Modes without a clear mapping stay blank for the reviewer to fill in.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3

MAP_ANY = {  # new mode <- old questions; yes if any old yes, no if all old answered no
    'm1_dead_missed': ('dw_om_blue_smaller', 'dw_om_grey_unmarked', 'dw_om_partial'),
    'm4_dw_on_lying_wood': ('dw_co_lying',),
    'm5_fc_trees_missed': ('fc_om_add',),
    'm6_fc_on_non_trees': ('fc_co_remove',),
}
# "Remove substantial blue" answered no means neither false-positive mode applies.
NEG_ONLY = {'m2_dw_on_live_vegetation': ('dw_co_remove', 'dw_co_most_wrong'),
            'm3_dw_on_non_vegetation': ('dw_co_remove', 'dw_co_most_wrong')}


def split(dataset_id):
    return 'holdout' if int(hashlib.sha256(f'gold-split-v1:{dataset_id}'.encode()).hexdigest(), 16) % 2 else 'tune'


def mapped(old):
    a = old['answers']
    new = {}
    values = [a.get(k) for k in a]
    if values and all(v == 'unsure' for v in values):
        return {'m0_assessable': False}
    new['m0_assessable'] = True
    for mode, keys in MAP_ANY.items():
        vals = [a.get(k) for k in keys]
        if any(v is True for v in vals):
            new[mode] = True
        elif all(v is False for v in vals):
            new[mode] = False
        elif any(v == 'unsure' for v in vals):
            new[mode] = 'unsure'
    for mode, keys in NEG_ONLY.items():
        if all(a.get(k) is False for k in keys):
            new[mode] = False
    return new


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    a = p.parse_args()
    old_crops = json.loads((a.root / 'crop-test.json').read_text())
    crops = []
    for c in old_crops:
        crops.append(dict(c, source='earlier test crop', prefix=c.get('prefix') or f"datasets/{c['dataset_id']}/{c['view']}-"))
    for d in sorted((a.root / 'gold-crops').iterdir()):
        t = d / 'truth.json'
        if t.exists():
            truth = json.loads(t.read_text())
            crops.append({'id': f"gold-{truth['dataset_id']}", 'dataset_id': truth['dataset_id'], 'view': truth['strategy'],
                          'mpp': truth['mpp'], 'prefix': f'gold-crops/{d.name}/', 'source': 'gold crop'})
    order = lambda c: hashlib.sha256(f"gold-order-v1:{c['id']}".encode()).hexdigest()
    crops.sort(key=lambda c: (c['source'] != 'gold crop', order(c)))
    for c in crops:
        c['split'] = split(c['dataset_id'])
        c.pop('batch', None)
    (a.root / 'gold-test.json').write_text(json.dumps(crops, indent=1))
    old = {r[0]: json.loads(r[1]) for r in sqlite3.connect(a.root / 'crop-labels.sqlite3').execute(
        'SELECT crop_id, payload FROM labels')}
    db = sqlite3.connect(a.root / 'gold-labels.sqlite3')
    db.execute('CREATE TABLE IF NOT EXISTS labels (crop_id TEXT PRIMARY KEY, payload TEXT, updated_at TEXT)')
    db.execute('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, crop_id TEXT, payload TEXT, at TEXT)')
    now = datetime.now(timezone.utc).isoformat()
    filled = 0
    for c in crops:
        if c['id'] in old and not db.execute('SELECT 1 FROM labels WHERE crop_id = ?', (c['id'],)).fetchone():
            payload = {'answers': mapped(old[c['id']]), 'note': old[c['id']].get('note', ''),
                       'prefilled_from': 'crop-labels.sqlite3 (icl questions)'}
            db.execute('INSERT INTO labels VALUES (?, ?, ?)', (c['id'], json.dumps(payload), now))
            filled += 1
    db.commit()
    print({'crops': len(crops), 'gold_new': sum(c['source'] == 'gold crop' for c in crops), 'prefilled': filled,
           'tune': sum(c['split'] == 'tune' for c in crops)})
