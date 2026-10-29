#!/usr/bin/env python3
"""
Release the queue claim of a processor that stopped sending heartbeats (DT-1471).

When a worker dies without its shutdown handler (host offline, hard kill), its
v2_queue row stays claimed and nothing else picks the dataset up. The
release_stale_queue_claim database function frees the claim and resets the
status in one transaction, but only after the claiming worker has been silent
for 15 minutes; otherwise it refuses and nothing changes. The task keeps its
task types and priority, so the next free worker processes it.

This is a production write: run it only with approval for the named datasets.

Example:
	python3 scripts/release_stale_queue_claim.py \\
		--env-file ~/.config/deadtrees/requeue.env --dataset-ids 15538
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from requeue_datasets_via_api import REQUIRED_KEYS, _http_json, _load_env_subset, _login, _parse_dataset_ids


def release(supabase_url: str, headers: dict, dataset_id: int) -> tuple[bool, str]:
	code, resp = _http_json(
		'POST',
		f'{supabase_url}/rest/v1/rpc/release_stale_queue_claim',
		headers=headers,
		body={'p_dataset_id': dataset_id},
	)
	if 200 <= code < 300 and isinstance(resp, dict):
		return True, f'released queue task {resp.get("id")}'
	message = resp.get('message') if isinstance(resp, dict) else resp
	return False, f'refused (HTTP {code}): {message}'


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument('--env-file', required=True, help='credentials file, e.g. ~/.config/deadtrees/requeue.env')
	parser.add_argument('--dataset-ids', required=True, help='comma-separated dataset ids')
	args = parser.parse_args()
	dataset_ids = _parse_dataset_ids(args.dataset_ids)

	env_path = Path(args.env_file).expanduser()
	if not env_path.exists():
		print(f'env file not found: {env_path}', file=sys.stderr)
		return 2
	env = _load_env_subset(env_path, REQUIRED_KEYS)
	missing = [k for k in REQUIRED_KEYS if not env.get(k)]
	if missing:
		print(f'missing keys in {env_path}: {", ".join(missing)}', file=sys.stderr)
		return 2

	supabase_url = env['SUPABASE_URL'].rstrip('/')
	token = _login(env, supabase_url)
	if token is None:
		return 3
	headers = {'apikey': env['SUPABASE_KEY'], 'Authorization': f'Bearer {token}', 'Accept': 'application/json'}

	failed = 0
	for dataset_id in dataset_ids:
		ok, outcome = release(supabase_url, headers, dataset_id)
		print(f'dataset_id={dataset_id} {outcome}')
		failed += not ok
	return 4 if failed else 0


if __name__ == '__main__':
	raise SystemExit(main())
