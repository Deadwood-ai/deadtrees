"""
Cron runner for the FreiData publication lifecycle.

State machine:
  pending    → run full pipeline → in_review (or error)
  uploading  → error when still uploading after FREIDATA_STALE_UPLOAD_HOURS
               (the run that set it was killed; only one cron tick runs at a time)
  in_review  → poll FreiData    → published / declined / still in_review
  published  → nothing (terminal)
  declined   → nothing (terminal)
  error      → nothing (requires manual intervention)

Usage:
  python -m freidata.cron          # one-shot
  # or via crontab calling scripts/freidata_cron.sh
"""
from __future__ import annotations

import datetime as dt
import tempfile
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional

from .config import load_config
from .db import get_supabase_client, update_publication_row
from .invenio_client import InvenioClient
from .logging_utils import setup_logging
from .notify import notify_error
from .pipeline import run_publication_safe
from .sync import sync_all


def fetch_pending_publications(db) -> List[Dict[str, Any]]:
	"""Return all publications with status='pending'."""
	resp = (
		db.table("data_publication")
		.select("id, title, status")
		.eq("status", "pending")
		.execute()
	)
	return resp.data or []


def _parse_timestamp(value: Optional[str]) -> Optional[dt.datetime]:
	if not value:
		return None
	parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
	return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)


def find_stale_uploads(
	rows: List[Dict[str, Any]], now: dt.datetime, max_age: dt.timedelta
) -> List[Dict[str, Any]]:
	"""Uploading publications whose upload started longer ago than max_age.

	upload_started_at marks an upload in progress; a finished draft-only run
	clears it and stays "uploading" until it is published or reviewed.
	"""
	stale = []
	for row in rows:
		started = _parse_timestamp(row.get("upload_started_at"))
		if started is not None and now - started > max_age:
			stale.append(row)
	return stale


def fail_stale_uploads(cfg, db, now: dt.datetime) -> List[int]:
	"""Mark interrupted uploads as error and notify, so they do not stay stuck."""
	resp = (
		db.table("data_publication")
		.select("id, title, freidata_record_id, upload_started_at")
		.eq("status", "uploading")
		.execute()
	)
	max_age = dt.timedelta(hours=cfg.stale_upload_hours)
	failed = []
	for pub in find_stale_uploads(resp.data or [], now, max_age):
		pub_id = pub["id"]
		update_publication_row(db, pub_id, {"status": "error"})
		failed.append(pub_id)
		print(f"[STALE] #{pub_id} still uploading after {cfg.stale_upload_hours:g} h -> error.")
		notify_error(
			cfg,
			pub_id=pub_id,
			title=pub.get("title") or f"Publication #{pub_id}",
			error_message=(
				f"Upload interrupted: the publication was still 'uploading' after {cfg.stale_upload_hours:g} hours. "
				"Set its status back to 'pending' to retry."
			),
			record_id=pub.get("freidata_record_id"),
		)
	return failed


def process_pending(cfg, db, pending: List[Dict[str, Any]]) -> None:
	"""Run the full publication pipeline for each pending publication."""
	for pub in pending:
		pub_id = pub["id"]
		title_short = (pub.get("title") or "")[:60]
		print(f"\n{'='*60}")
		print(f"[PENDING] #{pub_id} '{title_short}' — running pipeline...")
		print(f"{'='*60}")

		# The downloaded dataset bundles are removed once the publication is done.
		with tempfile.TemporaryDirectory(prefix=f"freidata_cron_{pub_id}_") as folder:
			try:
				run_publication_safe(cfg, db, Path(folder), pub_id)
				print(f"[OK] #{pub_id} pipeline completed.")
			except Exception:
				print(f"[ERROR] #{pub_id} pipeline failed:")
				traceback.print_exc()


def run_cron() -> None:
	"""Single cron tick: process pending publications + sync in_review ones."""
	cfg = load_config()

	# Set up logging to a shared cron log
	log_dir = Path(cfg.log_file).parent if cfg.log_file else Path("/tmp")
	log_dir.mkdir(parents=True, exist_ok=True)
	log_folder = log_dir
	setup_logging(log_folder, cfg)

	now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
	print(f"\n{'#'*60}")
	print(f"# FreiData cron run — {now}")
	print(f"{'#'*60}")

	db = get_supabase_client(cfg)

	# --- Phase 0: Fail uploads that a killed run left behind ---
	fail_stale_uploads(cfg, db, dt.datetime.now(dt.timezone.utc))

	# --- Phase 1: Publish pending publications ---
	pending = fetch_pending_publications(db)
	if pending:
		print(f"\n[cron] Found {len(pending)} pending publication(s).")
		process_pending(cfg, db, pending)
	else:
		print("[cron] No pending publications.")

	# --- Phase 2: Sync in_review publications ---
	print()
	client = InvenioClient(cfg.freidata_base_url, cfg.freidata_token, upload_timeout=cfg.upload_timeout)
	sync_all(client, db, cfg=cfg)

	print(f"\n[cron] Done.\n")


if __name__ == "__main__":
	run_cron()
