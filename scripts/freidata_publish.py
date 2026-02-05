#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Deprecated wrapper. Use freidata/cli.py instead.
CLI remains:
  python scripts/freidata_publish.py <folder_with_zips> <publication_id>
"""

from __future__ import annotations

import sys

from freidata.cli import main


if __name__ == "__main__":
	try:
		main()
	except Exception as e:
		print("\n[ERROR]", str(e), file=sys.stderr)
		sys.exit(1)
