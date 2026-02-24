#!/usr/bin/env python3
"""
Re-queue datasets via the production API using processor credentials from a .env file.

Why this exists:
- The prod repo's `.env` may contain non-shell lines, so `source .env` can be unsafe.
- This script parses only the keys we need and performs the auth + PUT requests.

Example:
	python3 scripts/requeue_datasets_via_api.py \\
		--dataset-ids 8046,8037,6479,6073 \\
		--priority 5
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path


REQUIRED_KEYS = [
	"SUPABASE_URL",
	"SUPABASE_KEY",
	"PROCESSOR_USERNAME",
	"PROCESSOR_PASSWORD",
]


DEFAULT_TASK_TYPES = [
	"odm_processing",
	"geotiff",
	"cog",
	"thumbnail",
	"metadata",
	"deadwood",
	"treecover",
]


def _load_env_subset(path: Path, keys: list[str]) -> dict[str, str]:
	want = set(keys)
	out: dict[str, str] = {}

	for raw in path.read_text().splitlines():
		line = raw.strip()
		if not line or line.startswith("#") or "=" not in line:
			continue
		k, v = line.split("=", 1)
		k = k.strip()
		if k not in want:
			continue
		out[k] = v.strip().strip('"').strip("'")

	return out


def _http_json(method: str, url: str, headers: dict[str, str], body: dict | None, timeout_s: int = 60):
	data = None
	if body is not None:
		data = json.dumps(body).encode("utf-8")
		headers = {**headers, "Content-Type": "application/json"}

	req = urllib.request.Request(url, data=data, headers=headers, method=method)
	try:
		with urllib.request.urlopen(req, timeout=timeout_s) as resp:
			text = resp.read().decode("utf-8", errors="replace")
			return resp.status, json.loads(text) if text else None
	except urllib.error.HTTPError as e:
		text = e.read().decode("utf-8", errors="replace")
		try:
			parsed = json.loads(text) if text else None
		except Exception:
			parsed = text
		return e.code, parsed


def _parse_dataset_ids(raw: str) -> list[int]:
	ids: list[int] = []
	for part in raw.replace(" ", ",").split(","):
		p = part.strip()
		if not p:
			continue
		try:
			ids.append(int(p))
		except ValueError:
			raise SystemExit(f"Invalid dataset id: {p!r}")
	if not ids:
		raise SystemExit("No dataset ids provided")
	return ids


def main() -> int:
	parser = argparse.ArgumentParser()
	parser.add_argument("--env-file", default=".env", help="Path to .env (default: .env)")
	parser.add_argument(
		"--api-base",
		default="https://data2.deadtrees.earth/api/v1",
		help="DeadTrees API base URL",
	)
	parser.add_argument(
		"--dataset-ids",
		required=True,
		help="Comma-separated dataset ids, e.g. 8046,8037,6479,6073",
	)
	parser.add_argument("--priority", type=int, default=5, help="1=highest, 5=lowest (default: 5)")
	parser.add_argument(
		"--task-types",
		default=",".join(DEFAULT_TASK_TYPES),
		help="Comma-separated task types (default: full pipeline)",
	)
	args = parser.parse_args()

	env_path = Path(args.env_file)
	if not env_path.exists():
		print(f"env file not found: {env_path}", file=sys.stderr)
		return 2

	env = _load_env_subset(env_path, REQUIRED_KEYS)
	missing = [k for k in REQUIRED_KEYS if not env.get(k)]
	if missing:
		print(f"missing keys in {env_path}: {', '.join(missing)}", file=sys.stderr)
		return 2

	supabase_url = env["SUPABASE_URL"].rstrip("/")

	# 1) Get processor token
	status, token_resp = _http_json(
		"POST",
		f"{supabase_url}/auth/v1/token?grant_type=password",
		headers={"apikey": env["SUPABASE_KEY"], "Accept": "application/json"},
		body={"email": env["PROCESSOR_USERNAME"], "password": env["PROCESSOR_PASSWORD"]},
		timeout_s=60,
	)

	if status != 200 or not isinstance(token_resp, dict) or "access_token" not in token_resp:
		print(f"token request failed (HTTP {status}): {token_resp}", file=sys.stderr)
		return 3

	token = token_resp["access_token"]

	dataset_ids = _parse_dataset_ids(args.dataset_ids)
	task_types = [t.strip() for t in str(args.task_types).split(",") if t.strip()]
	payload = {"task_types": task_types, "priority": int(args.priority)}

	ok = 0
	for dataset_id in dataset_ids:
		code, resp = _http_json(
			"PUT",
			f"{args.api_base.rstrip('/')}/datasets/{dataset_id}/process",
			headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
			body=payload,
			timeout_s=60,
		)

		# Keep output short; don't print secrets.
		if isinstance(resp, dict):
			short = {k: resp.get(k) for k in ("dataset_id", "id", "status", "message", "detail") if k in resp}
		else:
			short = resp
		print(f"dataset_id={dataset_id} http={code} resp={short}")

		if 200 <= code < 300:
			ok += 1

	if ok != len(dataset_ids):
		return 4
	return 0


if __name__ == "__main__":
	raise SystemExit(main())

