"""Small crop-level test set: pick crops, serve a quick yes/no labeling page, store answers.

The questions are exactly the Decisions predicates (decisions_crops.PREDICATES['icl']), so
model answers can be scored against the reviewer's answers crop by crop. Binds 127.0.0.1.
"""
import argparse
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import sqlite3
import threading

from decisions_crops import PREDICATES
from score_benchmark import truth

QUESTIONS = PREDICATES['icl']
UI = Path(__file__).parent / 'label_ui' / 'crops.html'


def pick(root, count):
    """One native crop per dataset, half from audited-bad and half from good datasets."""
    selection = json.loads((root / 'selection.json').read_text())['datasets']
    order = lambda i: hashlib.sha256(f'crop-test-v1:{i}'.encode()).hexdigest()
    bad = sorted((d for d in selection if d['role'] == 'audited_bad'), key=lambda d: order(d['dataset_id']))
    good = sorted((d for d in selection if d['role'] != 'audited_bad'), key=lambda d: order(d['dataset_id']))
    crops = []
    for group in (bad, good):
        taken = 0
        for d in group:
            ev_path = root / 'datasets' / str(d['dataset_id']) / 'evidence.json'
            if not ev_path.exists() or d['dataset_id'] == 8371 or taken >= count // 2:
                continue
            natives = [v for v in json.loads(ev_path.read_text())['views'] if v['kind'] == 'native']
            if not natives:
                continue
            # The crop with the most predicted deadwood, so there is something to judge.
            v = max(natives, key=lambda v: (v['predicted_fraction']['deadwood'], v['predicted_fraction']['forest_cover']))
            crops.append({'id': f"{d['dataset_id']}-{v['name'].upper()}", 'dataset_id': d['dataset_id'],
                          'view': v['name'], 'mpp': v['mpp']})
            taken += 1
    return sorted(crops, key=lambda c: order(c['id']))


def prefix(c):
    """Benchmark views live in datasets/<id>/<view>-*; reference patches in patch-truth/<patch>/*."""
    return c.get('prefix') or f"datasets/{c['dataset_id']}/{c['view']}-"


def add_patches(root, patch_ids):
    crops = json.loads((root / 'crop-test.json').read_text())
    known = {c['id'] for c in crops}
    for pid in patch_ids:
        t = json.loads((root / 'patch-truth' / str(pid) / 'truth.json').read_text())
        if f'patch-{pid}' not in known:
            crops.append({'id': f'patch-{pid}', 'dataset_id': t['dataset_id'], 'view': 'patch', 'mpp': t['mpp'],
                          'prefix': f'patch-truth/{pid}/', 'batch': 2})
    (root / 'crop-test.json').write_text(json.dumps(crops, indent=1))


class Store:
    def __init__(self, path):
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.lock = threading.Lock()
        self.db.execute('CREATE TABLE IF NOT EXISTS labels (crop_id TEXT PRIMARY KEY, payload TEXT, updated_at TEXT)')
        self.db.execute('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, crop_id TEXT, payload TEXT, at TEXT)')

    def all(self):
        return {r[0]: json.loads(r[1]) for r in self.db.execute('SELECT crop_id, payload FROM labels')}

    def save(self, crop_id, payload):
        now = datetime.now(timezone.utc).isoformat()
        with self.lock:
            self.db.execute('INSERT OR REPLACE INTO labels VALUES (?, ?, ?)', (crop_id, json.dumps(payload), now))
            self.db.execute('INSERT INTO events (crop_id, payload, at) VALUES (?, ?, ?)', (crop_id, json.dumps(payload), now))
        return now


def make_handler(root, crops, store):
    ids = {c['id'] for c in crops}
    files = {prefix(c) + s for c in crops
             for s in ('raw.jpg', 'deadwood-fill.png', 'deadwood-outline.png', 'forest_cover-fill.png', 'forest_cover-outline.png')}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def send(self, status, kind, body):
            self.send_response(status)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'")
            self.end_headers()
            self.wfile.write(body)

        def loopback(self):
            return re.fullmatch(r'(localhost|127\.0\.0\.1)(:\d{1,5})?', self.headers.get('Host', '')) is not None

        def do_GET(self):
            if not self.loopback():
                return self.send_error(403)
            path = self.path.split('?')[0]
            if path == '/':
                return self.send(200, 'text/html; charset=utf-8', UI.read_bytes())
            if path == '/api/crops':
                return self.send(200, 'application/json', json.dumps(
                    {'crops': crops, 'questions': QUESTIONS, 'labels': store.all()}).encode())
            name = path.removeprefix('/files/')
            if path.startswith('/files/') and name in files:
                kind = 'image/jpeg' if name.endswith('.jpg') else 'image/png'
                return self.send(200, kind, (root / name).read_bytes())
            self.send_error(404)

        def do_POST(self):
            host = self.headers.get('Host', '')
            if not self.loopback() or self.headers.get('Origin') != f'http://{host}' or self.path != '/api/label':
                return self.send_error(403)
            value = json.loads(self.rfile.read(min(int(self.headers.get('Content-Length', 0)), 8000)))
            crop_id = value.get('crop_id')
            answers = value.get('answers', {})
            if crop_id not in ids or not set(answers) <= set(QUESTIONS) or not all(v in (True, False, None, 'unsure') for v in answers.values()):
                return self.send(400, 'application/json', b'{"error":"invalid"}')
            at = store.save(crop_id, {'answers': answers, 'note': str(value.get('note', ''))[:500]})
            self.send(200, 'application/json', json.dumps({'saved': at}).encode())
    return Handler


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--port', type=int, default=8772)
    p.add_argument('--count', type=int, default=20)
    p.add_argument('--add-patches', type=int, nargs='*', help='append reference patches as extra test crops')
    a = p.parse_args()
    crop_file = a.root / 'crop-test.json'
    if not crop_file.exists():
        crop_file.write_text(json.dumps(pick(a.root, a.count), indent=1))
    if a.add_patches:
        add_patches(a.root, a.add_patches)
    crops = json.loads(crop_file.read_text())
    crops.sort(key=lambda c: c.get('batch', 1))
    server = ThreadingHTTPServer(('127.0.0.1', a.port), make_handler(a.root, crops, Store(a.root / 'crop-labels.sqlite3')))
    print(f'Crop labeling: http://127.0.0.1:{a.port}/ ({len(crops)} crops)', flush=True)
    server.serve_forever()
