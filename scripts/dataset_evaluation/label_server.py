#!/usr/bin/env python3
"""Privately host the dataset evaluation labeling page with a durable SQLite store.

Per dataset the page shows what the check's models see (the overview, up to four
crops and the thumbnail, from render_gold.py) and takes one call: keep, keep but fix,
exclude or unsure, with reasons and fix flags from the check's fixed lists. Every
save is kept (append-only history); the latest label per dataset is the gold label.
The old audit and model answers stay hidden until switched on.

Binds 127.0.0.1 only; reach it through an SSH tunnel:

	venv/bin/python scripts/dataset_evaluation/label_server.py --root .local/dataset-evaluation
"""

import argparse
import json
import mimetypes
import re
import sqlite3
import sys
import threading
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from processor.src.dataset_evaluation_v1.vocabulary import FIX_FLAGS, REASONS

UI = Path(__file__).parent / 'label_ui'
CALLS = ('keep', 'fix', 'exclude', 'unsure')
IMAGE_NAMES = re.compile(r'(overview|crop-[1-4]|thumbnail)\.jpg')


def is_loopback(authority):
	match = re.fullmatch(r'(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?', authority or '', re.IGNORECASE)
	return bool(match and (match[2] is None or 1 <= int(match[2]) <= 65535))


def validate(value: dict) -> dict:
	call = value.get('call')
	reasons = sorted(set(value.get('reasons') or []))
	flags = sorted(set(value.get('fix_flags') or []))
	if call not in CALLS:
		raise ValueError('Unknown call')
	if not set(reasons) <= set(REASONS) or not set(flags) <= set(FIX_FLAGS):
		raise ValueError('Unknown reason or fix flag')
	if call == 'exclude' and not reasons:
		raise ValueError('An exclusion needs a reason')
	if call != 'exclude' and reasons:
		raise ValueError('Only an exclusion has reasons')
	if call == 'fix' and not flags:
		raise ValueError('Keep but fix needs what to fix')
	return {
		'dataset_id': int(value['dataset_id']),
		'revision': int(value.get('revision', 0)),
		'call': call,
		'reasons': reasons,
		'fix_flags': flags,
		'note': str(value.get('note', ''))[:2000],
	}


class Store:
	def __init__(self, path: Path):
		self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
		self.lock = threading.Lock()
		self.db.execute('PRAGMA journal_mode=WAL')
		self.db.execute('PRAGMA synchronous=FULL')
		self.db.execute(
			'CREATE TABLE IF NOT EXISTS labels (dataset_id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, '
			'payload TEXT NOT NULL, updated_at TEXT NOT NULL)'
		)
		self.db.execute(
			'CREATE TABLE IF NOT EXISTS label_events (id INTEGER PRIMARY KEY, dataset_id INTEGER NOT NULL, '
			'revision INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, '
			'UNIQUE(dataset_id, revision))'
		)

	def all(self) -> dict:
		return {
			r[0]: dict(json.loads(r[2]), revision=r[1], updated_at=r[3])
			for r in self.db.execute('SELECT dataset_id, revision, payload, updated_at FROM labels')
		}

	def save(self, label: dict) -> dict:
		now = datetime.now(UTC).isoformat()
		payload = json.dumps({k: v for k, v in label.items() if k != 'revision'})
		with self.lock:
			self.db.execute('BEGIN IMMEDIATE')
			try:
				row = self.db.execute(
					'SELECT revision FROM labels WHERE dataset_id = ?', (label['dataset_id'],)
				).fetchone()
				current = row[0] if row else 0
				if label['revision'] != current:
					raise ValueError(f'Stale page: saved revision is {current}; reload before saving')
				self.db.execute(
					'INSERT OR REPLACE INTO labels VALUES (?, ?, ?, ?)',
					(label['dataset_id'], current + 1, payload, now),
				)
				self.db.execute(
					'INSERT INTO label_events (dataset_id, revision, payload, created_at) VALUES (?, ?, ?, ?)',
					(label['dataset_id'], current + 1, payload, now),
				)
				self.db.execute('COMMIT')
			except Exception:
				self.db.execute('ROLLBACK')
				raise
		return dict(json.loads(payload), revision=current + 1, updated_at=now)


class GoldSet:
	"""The selected datasets that have rendered images, plus any stored model answers."""

	def __init__(self, root: Path):
		self.root = root.resolve()
		self.store = Store(self.root / 'labels.sqlite3')
		self.load()

	def load(self):
		gold = json.loads((self.root / 'gold-set.json').read_text())
		datasets = []
		for d in gold['datasets']:
			folder = self.root / 'datasets' / str(d['dataset_id'])
			if not (folder / 'inputs.json').exists():
				continue
			inputs = json.loads((folder / 'inputs.json').read_text())
			models = {}
			for run in sorted((self.root / 'runs').glob('*/')) if (self.root / 'runs').exists() else []:
				path = run / f'{d["dataset_id"]}.json'
				if path.exists():
					models[run.name] = json.loads(path.read_text())
			datasets.append({**d, 'images': inputs['images'], 'mpp': inputs['mpp'], 'models': models})
		self.datasets = datasets
		self.ids = {d['dataset_id'] for d in datasets}


def make_handler(gold: GoldSet):
	class Handler(BaseHTTPRequestHandler):
		def log_message(self, *args):
			pass

		def headers_for(self, status, kind, length):
			self.send_response(status)
			self.send_header('Content-Type', kind)
			self.send_header('Content-Length', str(length))
			self.send_header('Cache-Control', 'no-store')
			self.send_header('X-Content-Type-Options', 'nosniff')
			self.send_header(
				'Content-Security-Policy',
				"default-src 'self'; img-src 'self'; style-src 'self'; "
				"script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
			)
			self.end_headers()

		def send_json(self, value, status=200):
			body = json.dumps(value, default=str).encode()
			self.headers_for(status, 'application/json; charset=utf-8', len(body))
			self.wfile.write(body)

		def send_file(self, path: Path):
			body = path.read_bytes()
			self.headers_for(200, mimetypes.guess_type(str(path))[0] or 'application/octet-stream', len(body))
			self.wfile.write(body)

		def do_GET(self):
			if not is_loopback(self.headers.get('Host')):
				return self.send_error(403, 'Loopback host required')
			path = unquote(urlsplit(self.path).path)
			if path in ('/', '/datasets.js', '/datasets.css'):
				return self.send_file(UI / ('datasets.html' if path == '/' else path[1:]))
			if path == '/api/datasets':
				gold.load()
				return self.send_json(
					{
						'datasets': gold.datasets,
						'labels': gold.store.all(),
						'reasons': list(REASONS),
						'fix_flags': list(FIX_FLAGS),
					}
				)
			match = re.fullmatch(r'/files/(\d+)/([\w.-]+)', path)
			if match and int(match[1]) in gold.ids and IMAGE_NAMES.fullmatch(match[2]):
				file = gold.root / 'datasets' / match[1] / match[2]
				if file.exists():
					return self.send_file(file)
			self.send_error(404)

		def do_POST(self):
			host = self.headers.get('Host', '')
			if not is_loopback(host) or self.headers.get('Origin') != f'http://{host}':
				return self.send_error(403, 'Same-origin request required')
			if urlsplit(self.path).path != '/api/label' or self.headers.get('Content-Type') != 'application/json':
				return self.send_error(404)
			try:
				length = int(self.headers.get('Content-Length', '0'))
				if not 0 < length <= 16000:
					raise ValueError('Invalid body size')
				label = validate(json.loads(self.rfile.read(length)))
				if label['dataset_id'] not in gold.ids:
					raise ValueError('Unknown dataset')
				self.send_json(gold.store.save(label))
			except (ValueError, TypeError, KeyError) as e:
				self.send_json({'error': str(e)}, 409 if 'Stale' in str(e) else 400)

	return Handler


def main():
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument('--root', type=Path, required=True)
	parser.add_argument('--port', type=int, default=8781)
	args = parser.parse_args()
	gold = GoldSet(args.root)
	server = ThreadingHTTPServer(('127.0.0.1', args.port), make_handler(gold))
	print(f'Dataset evaluation labeling: http://127.0.0.1:{args.port}/ ({len(gold.datasets)} datasets)', flush=True)
	server.serve_forever()


if __name__ == '__main__':
	main()
