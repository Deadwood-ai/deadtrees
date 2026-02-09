"""
Cron runner for the FreiData publication lifecycle.

State machine:
  pending    → run full pipeline → in_review (or error)
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
from typing import Any, Dict, List

from .config import load_config
from .db import get_supabase_client
from .invenio_client import InvenioClient
from .logging_utils import setup_logging
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


def process_pending(cfg, db, pending: List[Dict[str, Any]]) -> None:
	"""Run the full publication pipeline for each pending publication."""
	for pub in pending:
		pub_id = pub["id"]
		title_short = (pub.get("title") or "")[:60]
		print(f"\n{'='*60}")
		print(f"[PENDING] #{pub_id} '{title_short}' — running pipeline...")
		print(f"{'='*60}")

		folder = Path(tempfile.mkdtemp(prefix=f"freidata_cron_{pub_id}_"))
		try:
			run_publication_safe(cfg, db, folder, pub_id)
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
