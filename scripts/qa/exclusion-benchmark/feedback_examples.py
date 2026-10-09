"""Turn reviewer verdicts on Sol's boxes into captioned native-resolution examples.

Each box marked Wrong (with its note) and each reviewer-drawn box becomes one image
(raw | deadwood | forest at native detail) plus a caption, for use as visual
corrections in later Sol runs. Datasets used here count as tuning data.
"""
import argparse
import json
from pathlib import Path
import sqlite3

from zoom_tool import Zoom

KIND_TEXT = {'missed_by_sol': 'a real error that screening missed', 'real_error': 'a real error',
             'correct_prediction': 'a correct prediction', 'not_a_tree': 'not a standing tree', 'note': 'a note'}


def collect(root):
    selection = {d['dataset_id']: d for d in json.loads((root / 'selection.json').read_text())['datasets']}
    items = []
    for dataset_id, payload in sqlite3.connect(root / 'labels.sqlite3').execute('SELECT dataset_id, payload FROM labels'):
        label = json.loads(payload)
        for key, fb in (label.get('box_feedback') or {}).items():
            if fb.get('verdict') != 'wrong':
                continue
            run, layer, issue, region = key.rsplit(':', 3)
            result = json.loads((root / 'runs' / run / 'datasets' / str(dataset_id) / 'result.json').read_text())
            found = result['answer']['layers'][layer]['issues'][int(issue)]
            r = found['regions'][int(region)]
            caption = (f"An earlier screening flagged this as {layer} {found['mode'].replace('_', ' ')}; "
                       f"the reviewer says that is WRONG" + (f": {fb['note']}" if fb.get('note') else '') + '.')
            items.append({'dataset': selection[dataset_id], 'view': r['view'], 'box': r['box'], 'caption': caption})
        for box in label.get('user_boxes') or []:
            caption = (f"Reviewer box on {box['layer']}: {KIND_TEXT[box['kind']]}"
                       + (f" ({box['note']})" if box.get('note') else '') + '.')
            items.append({'dataset': selection[dataset_id], 'view': box['view'], 'box': box['box'], 'caption': caption})
    return items


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    a.output.mkdir(parents=True, exist_ok=True)
    manifest = []
    for n, item in enumerate(collect(a.root), 1):
        zoom = Zoom(a.root, item['dataset'], a.output / 'tmp', budget=1)
        try:
            x0, y0, x1, y1 = item['box']
            zoom.inspect({'view': item['view'], 'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1, 'purpose': 'reviewer example'})
        finally:
            zoom.close()
        target = a.output / f'FB{n}.jpg'
        (a.output / 'tmp' / 'Z1.jpg').replace(target)
        manifest.append({'name': f'FB{n}', 'file': target.name, 'dataset_id': item['dataset']['dataset_id'],
                         'caption': item['caption']})
        print(manifest[-1]['name'], item['dataset']['dataset_id'], item['caption'][:100], flush=True)
    (a.output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
