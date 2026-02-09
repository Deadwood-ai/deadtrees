from __future__ import annotations

import argparse
import tempfile
from pathlib import Path
import sys

from .config import load_config
from .db import get_supabase_client
from .logging_utils import setup_logging
from .pipeline import run_publication_safe


def cmd_publish(args: argparse.Namespace) -> None:
	"""Run the publication pipeline for a single publication."""
	publication_id = int(args.publication_id)

	if args.folder:
		folder = Path(args.folder).expanduser().resolve()
		folder.mkdir(parents=True, exist_ok=True)
	else:
		folder = Path(tempfile.mkdtemp(prefix=f"freidata_{publication_id}_"))
		print(f"[INFO] Using temp folder: {folder}")

	cfg = load_config()
	setup_logging(folder, cfg)
	db = get_supabase_client(cfg)
	run_publication_safe(cfg, db, folder, publication_id)


def cmd_cron(args: argparse.Namespace) -> None:
	"""Run one cron tick: process pending + sync in_review."""
	from .cron import run_cron
	run_cron()


def cmd_sync(args: argparse.Namespace) -> None:
	"""Sync in_review publications against FreiData (no new publishes)."""
	from .sync import sync_all
	from .invenio_client import InvenioClient

	cfg = load_config()
	log_folder = Path(tempfile.mkdtemp(prefix="freidata_sync_"))
	setup_logging(log_folder, cfg)
	db = get_supabase_client(cfg)
	client = InvenioClient(cfg.freidata_base_url, cfg.freidata_token, upload_timeout=cfg.upload_timeout)
	sync_all(client, db, cfg=cfg)


def main() -> None:
	parser = argparse.ArgumentParser(
		description="FreiData publication tools"
	)
	subparsers = parser.add_subparsers(dest="command", help="Available commands")

	# --- publish ---
	p_publish = subparsers.add_parser("publish", help="Publish a single publication to FreiData")
	p_publish.add_argument("publication_id", type=int, help="Publication ID from data_publication table")
	p_publish.add_argument("--folder", type=str, default=None, help="Working folder for ZIPs (auto-created if not provided)")
	p_publish.set_defaults(func=cmd_publish)

	# --- cron ---
	p_cron = subparsers.add_parser("cron", help="Run one cron tick: publish pending + sync in_review")
	p_cron.set_defaults(func=cmd_cron)

	# --- sync ---
	p_sync = subparsers.add_parser("sync", help="Sync in_review publications against FreiData")
	p_sync.set_defaults(func=cmd_sync)

	args = parser.parse_args()
	if not hasattr(args, "func"):
		parser.print_help()
		sys.exit(1)

	args.func(args)


if __name__ == "__main__":
	try:
		main()
	except Exception as e:
		print("\n[ERROR]", str(e), file=sys.stderr)
		sys.exit(1)
