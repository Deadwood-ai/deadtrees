"""Privately host the dataset-level labeling page with a durable SQLite store.

Binds 127.0.0.1 only. The original audit is shown next to each dataset (pseudonymous auditor).
"""
import argparse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import re
import sqlite3
import threading
from pathlib import Path
from urllib.parse import unquote, urlsplit

UI = Path(__file__).parent / 'label_ui'
SOL_RUN = 'sol-issue-finder-v6-zoom'  # model judgement shown next to the audit
LAYERS = ('deadwood', 'forest_cover')
VERDICTS = ('keep', 'exclude', 'unsure')
AREAS = ('lt5', '5to20', '20to50', 'gt50')
TAGS = {
    'deadwood': ('omission', 'partial_crowns', 'commission_ground', 'commission_vegetation',
                 'commission_snow_water', 'shadow', 'phenology', 'coverage_processing'),
    'forest_cover': ('omission', 'commission', 'filled_gaps', 'dead_trees_excluded',
                     'missing_or_partial_layer', 'coverage_processing'),
    'imagery': ('blurry_or_low_res', 'nodata_or_artifacts', 'misaligned', 'out_of_season', 'not_forest'),
}


def is_loopback(authority):
    match = re.fullmatch(r'(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?', authority or '', re.I)
    return bool(match and (match[2] is None or 1 <= int(match[2]) <= 65535))


def validate(value):
    out = {'dataset_id': int(value['dataset_id']), 'revision': int(value.get('revision', 0)),
           'note': str(value.get('note', ''))[:2000], 'layers': {}, 'imagery_tags': []}
    for layer in LAYERS:
        item = value.get('layers', {}).get(layer, {})
        verdict = item.get('verdict')
        area = item.get('area')
        tags = item.get('tags', [])
        if verdict not in (None, *VERDICTS) or area not in (None, *AREAS) or not set(tags) <= set(TAGS[layer]):
            raise ValueError(f'Invalid {layer} label')
        out['layers'][layer] = {'verdict': verdict, 'area': area, 'tags': sorted(set(tags))}
    if not set(value.get('imagery_tags', [])) <= set(TAGS['imagery']):
        raise ValueError('Invalid imagery tag')
    out['imagery_tags'] = sorted(set(value.get('imagery_tags', [])))
    return out


class Store:
    def __init__(self, path):
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.lock = threading.Lock()
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS labels (dataset_id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, '
                        'payload TEXT NOT NULL, updated_at TEXT NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS label_events (id INTEGER PRIMARY KEY, dataset_id INTEGER NOT NULL, '
                        'revision INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, '
                        'UNIQUE(dataset_id, revision))')

    def all(self):
        return {r[0]: dict(json.loads(r[2]), revision=r[1], updated_at=r[3])
                for r in self.db.execute('SELECT dataset_id, revision, payload, updated_at FROM labels')}

    def save(self, label):
        now = datetime.now(timezone.utc).isoformat()
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            try:
                row = self.db.execute('SELECT revision FROM labels WHERE dataset_id = ?', (label['dataset_id'],)).fetchone()
                current = row[0] if row else 0
                if label['revision'] != current:
                    raise ValueError(f'Stale page: saved revision is {current}; reload before saving')
                revision = current + 1
                payload = json.dumps({k: v for k, v in label.items() if k != 'revision'})
                self.db.execute('INSERT OR REPLACE INTO labels VALUES (?, ?, ?, ?)',
                                (label['dataset_id'], revision, payload, now))
                self.db.execute('INSERT INTO label_events (dataset_id, revision, payload, created_at) VALUES (?, ?, ?, ?)',
                                (label['dataset_id'], revision, payload, now))
                self.db.execute('COMMIT')
            except Exception:
                self.db.execute('ROLLBACK')
                raise
        return dict(json.loads(payload), revision=revision, updated_at=now)


class Benchmark:
    def __init__(self, root):
        self.root = root.resolve()
        self.store = Store(self.root / 'labels.sqlite3')
        self.load()

    def load(self):
        """Re-read evidence so datasets rendered after startup appear on reload."""
        selection = json.loads((self.root / 'selection.json').read_text())
        datasets, files = [], set()
        for d in selection['datasets']:
            evidence_path = self.root / 'datasets' / str(d['dataset_id']) / 'evidence.json'
            if not evidence_path.exists():
                continue
            evidence = json.loads(evidence_path.read_text())
            sol_path = self.root / 'runs' / SOL_RUN / 'datasets' / str(d['dataset_id']) / 'result.json'
            sol = json.loads(sol_path.read_text())['answer'] if sol_path.exists() else None
            # Blind: only imagery facts and the evidence views reach the page.
            datasets.append({k: evidence[k] for k in ('dataset_id', 'native_mpp', 'aoi_area_ha', 'views', 'cog')}
                                 | {'platform': d['platform'], 'biome': d['biome'], 'country': d['country'],
                                    'acquisition': [d['aquisition_year'], d['aquisition_month']],
                                    # Shown on request (8 Oct): labels are no longer blind to the old audit.
                                    'audit': {k: d.get(k) for k in (
                                        'deadwood_quality', 'deadwood_notes', 'forest_cover_quality',
                                        'forest_cover_notes', 'final_assessment', 'has_valid_phenology',
                                        'audit_date', 'auditor', 'role', 'tags')},
                                    'sol': sol and {l: {k: sol['layers'][l].get(k) for k in (
                                        'auditor_grade', 'commission_pct', 'omission_pct', 'reason')}
                                        for l in LAYERS}})
            files.update(f"datasets/{d['dataset_id']}/{name}" for name in evidence['files'])
        # Stable shuffled order so roles and audit grades cannot be read from the sequence.
        queue_path = self.root / 'adjudication.json'
        queue = json.loads(queue_path.read_text())['datasets'] if queue_path.exists() else {}
        for d in datasets:
            d['adjudicate'] = queue.get(str(d['dataset_id']), [])
        # Adjudication first, then a stable shuffled order.
        datasets.sort(key=lambda d: (not d['adjudicate'], hash_order(d['dataset_id'])))
        self.datasets, self.files = datasets, files


def hash_order(dataset_id):
    import hashlib
    return hashlib.sha256(f'exclusion-benchmark-v1:{dataset_id}'.encode()).hexdigest()


def make_handler(bench):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def headers_for(self, status, kind, length):
            self.send_response(status)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(length))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self'; style-src 'self'; "
                             "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
            self.end_headers()

        def send_json(self, value, status=200):
            body = json.dumps(value, default=str).encode()
            self.headers_for(status, 'application/json; charset=utf-8', len(body))
            self.wfile.write(body)

        def send_file(self, path):
            body = path.read_bytes()
            self.headers_for(200, mimetypes.guess_type(str(path))[0] or 'application/octet-stream', len(body))
            self.wfile.write(body)

        def do_GET(self):
            if not is_loopback(self.headers.get('Host')):
                return self.send_error(403, 'Loopback host required')
            path = unquote(urlsplit(self.path).path)
            if path == '/api/datasets':
                bench.load()
                return self.send_json({'datasets': bench.datasets, 'labels': bench.store.all(), 'tags': TAGS})
            if path in ('/', '/label.js', '/label.css'):
                return self.send_file(UI / ('label.html' if path == '/' else path[1:]))
            name = path.removeprefix('/files/')
            if path.startswith('/files/') and name in bench.files:
                return self.send_file(bench.root / name)
            self.send_error(404)

        def do_POST(self):
            host = self.headers.get('Host', '')
            if not is_loopback(host) or self.headers.get('Origin') != f'http://{host}':
                return self.send_error(403, 'Same-origin request required')
            if urlsplit(self.path).path != '/api/label' or self.headers.get('Content-Type') != 'application/json':
                return self.send_error(404)
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 8000:
                    raise ValueError('Invalid body size')
                label = validate(json.loads(self.rfile.read(length)))
                if label['dataset_id'] not in {d['dataset_id'] for d in bench.datasets}:
                    raise ValueError('Unknown dataset')
                self.send_json(bench.store.save(label))
            except (ValueError, TypeError, KeyError) as e:
                self.send_json({'error': str(e)}, 409 if 'Stale' in str(e) else 400)
    return Handler


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--port', type=int, default=8771)
    a = p.parse_args()
    bench = Benchmark(a.root)
    server = ThreadingHTTPServer(('127.0.0.1', a.port), make_handler(bench))
    print(f'Exclusion benchmark labeling: http://127.0.0.1:{a.port}/ ({len(bench.datasets)} datasets)', flush=True)
    server.serve_forever()
