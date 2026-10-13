"""Move gold-crop labels from the gold7 questions to gold9 (13 Oct): blocks per layer.

The shared artifact answer becomes one answer per layer: "no" and "?" carry over to both,
"yes" is left open so the reviewer says which layer it hit. A layer without any yes gets the
verdict OK; layers with a yes are left open for the reviewer's verdict. The old artifact answer
and the per-mode sizes are kept under "legacy". Writes a backup next to the database first.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import sqlite3

LAYERS = {'v_deadwood': ('m1_dead_missed', 'm2_dw_on_live_vegetation', 'm3_dw_on_non_vegetation', 'm4_dw_on_lying_wood', 'm7_dw_artifact'),
          'v_forest': ('m5_fc_trees_missed', 'm6_fc_on_non_trees', 'm8_dead_not_forest', 'm7_fc_artifact')}


def migrate(payload):
    if 'legacy' in payload:
        return payload
    answers = dict(payload['answers'])
    artifact = answers.pop('m7_artifact', None)
    if artifact in (False, 'unsure'):
        answers['m7_dw_artifact'] = answers['m7_fc_artifact'] = artifact
    if answers.get('m0_assessable') is not False:
        for verdict, modes in LAYERS.items():
            if all(answers.get(m) in (False, 'unsure') for m in modes):
                answers[verdict] = 'ok'
    return {'answers': answers, 'sizes': {}, 'note': payload.get('note', ''),
            'legacy': {'m7_artifact': artifact, 'sizes': payload.get('sizes', {})}}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--db', type=Path, required=True)
    a = p.parse_args()
    backup = a.db.with_name(a.db.stem + '.gold7-backup.sqlite3')
    if not backup.exists():
        shutil.copy2(a.db, backup)
    db = sqlite3.connect(a.db, isolation_level=None)
    now = datetime.now(timezone.utc).isoformat()
    rows = db.execute('SELECT crop_id, payload FROM labels').fetchall()
    for crop_id, payload in rows:
        new = migrate(json.loads(payload))
        db.execute('UPDATE labels SET payload = ?, updated_at = ? WHERE crop_id = ?', (json.dumps(new), now, crop_id))
        db.execute('INSERT INTO events (crop_id, payload, at) VALUES (?, ?, ?)', (crop_id, json.dumps(new), now))
    print(f'migrated {len(rows)} labels; backup at {backup}')
