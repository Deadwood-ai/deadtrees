from __future__ import annotations

import argparse
from pathlib import Path
import sys

from .config import load_config
from .db import get_supabase_client
from .logging_utils import setup_logging
from .pipeline import run_publication_safe


def main() -> None:
	parser = argparse.ArgumentParser()
	parser.add_argument("folder", type=str)
	parser.add_argument("publication_id", type=int)
	args = parser.parse_args()

	folder = Path(args.folder).expanduser().resolve()
	publication_id = int(args.publication_id)

	if not folder.exists() or not folder.is_dir():
		raise RuntimeError(f"Ordner existiert nicht: {folder}")

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
