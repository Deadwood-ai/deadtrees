from __future__ import annotations

import argparse
import tempfile
from pathlib import Path
import sys

from .config import load_config
from .db import get_supabase_client
from .logging_utils import setup_logging
from .pipeline import run_publication_safe


def main() -> None:
	parser = argparse.ArgumentParser(
		description="Publish datasets to FreiData (InvenioRDM)"
	)
	parser.add_argument(
		"publication_id",
		type=int,
		help="Publication ID from data_publication table"
	)
	parser.add_argument(
		"--folder",
		type=str,
		default=None,
		help="Working folder for ZIPs (auto-created if not provided)"
	)
	args = parser.parse_args()

	publication_id = int(args.publication_id)

	# Auto-create folder if not provided
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


if __name__ == "__main__":
	try:
		main()
	except Exception as e:
		print("\n[ERROR]", str(e), file=sys.stderr)
		sys.exit(1)
