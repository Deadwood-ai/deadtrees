#!/usr/bin/env python3
"""
Queue the georeferencing check (georef_check_v1) for datasets that need it.

The stage reads the stored COG and AOI, so it runs on its own (no geotiff) and
is queued at the lowest priority behind real uploads. A rerun replaces the check
and its is_georeferenced audit suggestion; saved audits are never changed. Where
a Good/Poor call disagrees with a saved audit, the dataset shows up in
`audit_review_queue` (the Re-review tab of the audit page).

Selection (default): every non-archived dataset with a COG whose check is
missing or was made with other rules or another matcher. --audited restricts
that to datasets with a saved audit (the backfill against existing audits);
--all picks every dataset with a COG.

Example:
	python3 scripts/requeue_georef_check.py --audited --dry-run
	python3 scripts/requeue_georef_check.py --audited --limit 500
	python3 scripts/requeue_georef_check.py --dataset-ids 6924,10442
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from requeue_datasets_via_api import REQUIRED_KEYS, _http_json, _load_env_subset, _parse_dataset_ids
from requeue_doy_estimation import TOKEN_REFRESH_EVERY, _login, _select_all

TASK_TYPE = 'georef_check_v1'
# keep in sync with processor/src/georef_check_v1 (evidence.RULES_VERSION, check.MODEL_VERSION)
RULES_VERSION = 'georef-rules-v1'
MODEL_VERSION = 'romav2.0.1'


def needs_check(check: dict | None, rules_version: str, model_version: str) -> str | None:
	"""Why a dataset should be (re)checked, or None."""
	if check is None:
		return 'missing'
	if check['rules_version'] != rules_version:
		return 'rules_version'
	if check['model_version'] != model_version:
		return 'model_version'
	return None


def main() -> int:
	parser = argparse.ArgumentParser()
	parser.add_argument('--env-file', default='.env')
	parser.add_argument('--api-base', default='https://data2.deadtrees.earth/api/v1')
	group = parser.add_mutually_exclusive_group()
	group.add_argument('--all', action='store_true', help='every dataset with a COG')
	group.add_argument('--dataset-ids', help='comma-separated dataset ids')
	parser.add_argument('--audited', action='store_true', help='only datasets with a saved audit')
	parser.add_argument('--rules-version', default=RULES_VERSION)
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
		datasets = _select_all(supabase_url, headers, 'v2_datasets', 'id', {'archived': 'is.false'})
		audited = (
			{r['dataset_id'] for r in _select_all(supabase_url, headers, 'dataset_audit', 'dataset_id')} if args.audited else None
		)
		checks = {
			r['dataset_id']: r
			for r in _select_all(supabase_url, headers, 'v2_georef_checks', 'dataset_id,rules_version,model_version')
		}
		todo = []
		for d in datasets:
			if d['id'] not in with_cog or (audited is not None and d['id'] not in audited):
				continue
			reason = 'all' if args.all else needs_check(checks.get(d['id']), args.rules_version, args.model_version)
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
