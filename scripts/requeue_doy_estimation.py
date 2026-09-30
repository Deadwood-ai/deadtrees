#!/usr/bin/env python3
"""
Queue the acquisition-date stage (doy_estimation_v1) for datasets that need it.

The stage reads the stored COG, so it runs on its own (no geotiff) and is
queued at the lowest priority behind real uploads. A rerun replaces the
estimate and the stage's audit suggestions. A date decision the new estimate
contradicts is deactivated (kept, with date and reason) and the dataset shows
up in `acquisition_date_review_queue`; decisions it agrees with stay active.
To re-check every decision made before a date (e.g. after a model upgrade),
run `select public.supersede_acquisition_date_decisions_before('<date>')` as
service role before queueing.

Selection (default --stale): every non-archived dataset with a COG whose
estimate is missing, from another model version, or assessed against a date
the dataset no longer has. --retry-s2 also picks no-S2 estimates whose S2
lookup can succeed later (block not processed yet, flight after the cube end,
lookup error). --all picks every dataset with a COG.

Example:
	python3 scripts/requeue_doy_estimation.py --dry-run
	python3 scripts/requeue_doy_estimation.py --retry-s2 --limit 500
	python3 scripts/requeue_doy_estimation.py --dataset-ids 6192,1611
"""

from __future__ import annotations

import argparse
import sys
import time
import urllib.parse
from pathlib import Path

from requeue_datasets_via_api import REQUIRED_KEYS, _http_json, _load_env_subset, _parse_dataset_ids

TASK_TYPE = 'doy_estimation_v1'
# keep in sync with shared/asset_manifest.py DOY_ESTIMATION_MODEL_DIR_NAME
MODEL_VERSION = 'doy_estimation_v1'
RETRYABLE_S2_STATUSES = {'no_block', 'outside_archive', 'no_credentials', 'error'}
PAGE = 1000
TOKEN_REFRESH_EVERY = 500  # processor JWTs expire after an hour


def _login(env: dict, supabase_url: str) -> str | None:
	code, resp = _http_json(
		'POST',
		f'{supabase_url}/auth/v1/token?grant_type=password',
		headers={'apikey': env['SUPABASE_KEY'], 'Accept': 'application/json'},
		body={'email': env['PROCESSOR_USERNAME'], 'password': env['PROCESSOR_PASSWORD']},
	)
	if code != 200 or 'access_token' not in (resp or {}):
		print(f'token request failed (HTTP {code})', file=sys.stderr)
		return None
	return resp['access_token']


def _select_all(supabase_url: str, headers: dict, table: str, select: str, filters: dict | None = None) -> list[dict]:
	rows, offset = [], 0
	while True:
		query = urllib.parse.urlencode({'select': select, **(filters or {}), 'order': 'dataset_id.asc' if table != 'v2_datasets' else 'id.asc'})
		code, resp = _http_json(
			'GET',
			f'{supabase_url}/rest/v1/{table}?{query}',
			headers={**headers, 'Range-Unit': 'items', 'Range': f'{offset}-{offset + PAGE - 1}'},
			body=None,
		)
		if code not in (200, 206):
			raise SystemExit(f'{table} query failed (HTTP {code}): {resp}')
		rows.extend(resp)
		if len(resp) < PAGE:
			return rows
		offset += PAGE


def needs_estimate(dataset: dict, estimate: dict | None, model_version: str, retry_s2: bool) -> str | None:
	"""Why a dataset should be (re)estimated, or None."""
	if estimate is None:
		return 'missing'
	if estimate['model_version'] != model_version:
		return 'model_version'
	recorded = (estimate['recorded_year'], estimate['recorded_month'], estimate['recorded_day'])
	if recorded != (dataset['aquisition_year'], dataset['aquisition_month'], dataset['aquisition_day']):
		return 'date_changed'
	s2_status = ((estimate.get('metadata') or {}).get('s2') or {}).get('status')
	if retry_s2 and estimate['model_type'] == 'nos2' and s2_status in RETRYABLE_S2_STATUSES:
		return f's2_{s2_status}'
	return None


def main() -> int:
	parser = argparse.ArgumentParser()
	parser.add_argument('--env-file', default='.env')
	parser.add_argument('--api-base', default='https://data2.deadtrees.earth/api/v1')
	group = parser.add_mutually_exclusive_group()
	group.add_argument('--all', action='store_true', help='every dataset with a COG')
	group.add_argument('--dataset-ids', help='comma-separated dataset ids')
	parser.add_argument('--retry-s2', action='store_true', help='also rerun no-S2 estimates whose S2 lookup may succeed now')
	parser.add_argument('--model-version', default=MODEL_VERSION)
	parser.add_argument('--priority', type=int, default=1, help='5=highest, 1=lowest (default: 1)')
	parser.add_argument('--limit', type=int, default=0, help='queue at most this many (0 = no limit)')
	parser.add_argument('--sleep', type=float, default=0.2, help='seconds between API calls')
	parser.add_argument('--dry-run', action='store_true')
	args = parser.parse_args()

	env = _load_env_subset(Path(args.env_file), REQUIRED_KEYS)
	missing = [k for k in REQUIRED_KEYS if not env.get(k)]
	if missing:
		print(f'missing keys in {args.env_file}: {", ".join(missing)}', file=sys.stderr)
		return 2
	supabase_url = env['SUPABASE_URL'].rstrip('/')
	token = _login(env, supabase_url)
	if not token:
		return 3
	headers = {'apikey': env['SUPABASE_KEY'], 'Authorization': f'Bearer {token}', 'Accept': 'application/json'}

	if args.dataset_ids:
		todo = [(i, 'requested') for i in _parse_dataset_ids(args.dataset_ids)]
	else:
		with_cog = {r['dataset_id'] for r in _select_all(supabase_url, headers, 'v2_statuses', 'dataset_id', {'is_cog_done': 'is.true'})}
		datasets = _select_all(
			supabase_url, headers, 'v2_datasets', 'id,aquisition_year,aquisition_month,aquisition_day', {'archived': 'is.false'}
		)
		estimates = {
			r['dataset_id']: r
			for r in _select_all(
				supabase_url,
				headers,
				'v2_acquisition_date_estimates',
				'dataset_id,model_version,model_type,recorded_year,recorded_month,recorded_day,metadata',
			)
		}
		todo = []
		for d in datasets:
			if d['id'] not in with_cog or not d['aquisition_year']:
				continue
			reason = 'all' if args.all else needs_estimate(d, estimates.get(d['id']), args.model_version, args.retry_s2)
			if reason:
				todo.append((d['id'], reason))
	if args.limit:
		todo = todo[: args.limit]

	counts: dict[str, int] = {}
	for _, reason in todo:
		counts[reason] = counts.get(reason, 0) + 1
	print(f'{len(todo)} datasets to queue: {counts}')
	if args.dry_run:
		return 0

	failed = 0
	for n, (dataset_id, reason) in enumerate(todo):
		if n and n % TOKEN_REFRESH_EVERY == 0:
			token = _login(env, supabase_url) or token
		code, resp = _http_json(
			'PUT',
			f'{args.api_base.rstrip("/")}/datasets/{dataset_id}/process',
			headers={'Authorization': f'Bearer {token}', 'Accept': 'application/json'},
			body={'task_types': [TASK_TYPE], 'priority': args.priority},
		)
		if not 200 <= code < 300:
			failed += 1
			print(f'dataset_id={dataset_id} reason={reason} http={code} resp={resp}')
		time.sleep(args.sleep)
	print(f'queued {len(todo) - failed}, failed {failed}')
	return 4 if failed else 0


if __name__ == '__main__':
	raise SystemExit(main())
