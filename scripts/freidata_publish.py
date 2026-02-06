#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Wrapper for freidata publication CLI.

Usage:
  python scripts/freidata_publish.py publish <publication_id> [--folder <path>]
  python scripts/freidata_publish.py cron
  python scripts/freidata_publish.py sync

If --folder is not provided, a temp folder is auto-created.
With AUTO_DOWNLOAD=1 (default), datasets are automatically bundled from the API.
"""

from __future__ import annotations

import sys
from pathlib import Path

repo_root = Path(__file__).resolve().parents[1]
if str(repo_root) not in sys.path:
	sys.path.insert(0, str(repo_root))

from freidata.cli import main


if __name__ == "__main__":
	try:
		main()
	except Exception as e:
		print("\n[ERROR]", str(e), file=sys.stderr)
		sys.exit(1)
