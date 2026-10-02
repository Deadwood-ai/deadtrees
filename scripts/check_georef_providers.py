#!/usr/bin/env python3
"""Live check of the georeferencing-check reference providers.

Renders a ~300 m box at each provider's check site (providers.json
`check_lonlat`) the way the processor stage does, and reports whether real
imagery came back. Keyed providers are checked only when their key is set in
the environment. Run it when adding a provider and now and then, because
public map services move and retire (year-specific URLs in particular).

Example (from the repository root, in an environment with the processor deps):
	python3 scripts/check_georef_providers.py
	python3 scripts/check_georef_providers.py --only de- ch-swissimage
"""

from __future__ import annotations

import argparse
import math
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from processor.src.georef_check_v1.evidence import Grid  # noqa: E402
from processor.src.georef_check_v1.providers import REGISTRY  # noqa: E402
from processor.src.georef_check_v1.references import _render, _session  # noqa: E402
from shared.settings import settings  # noqa: E402

HALF_M = 150.0  # half the box side, ground metres
PIXELS = 512


def box_grid(lon: float, lat: float) -> Grid:
	x = math.radians(lon) * 6378137
	y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * 6378137
	half = HALF_M / math.cos(math.radians(lat))  # Web-Mercator metres for ~150 ground metres
	return Grid((x - half, y - half, x + half, y + half), PIXELS, PIXELS)


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument('--only', nargs='*', help='provider names or name prefixes')
	args = parser.parse_args()
	session = _session()
	failed = 0
	for p in REGISTRY:
		if args.only and not any(p.name.startswith(o) for o in args.only):
			continue
		if p.key_setting and not getattr(settings, p.key_setting):
			print(f'{p.name:28s} skipped (no {p.key_setting})')
			continue
		started = time.monotonic()
		try:
			image, _ = _render(box_grid(*p.check_lonlat), p, session)
			std = float(np.max(image.reshape(-1, 3).std(axis=0)))
			ok = std > 5
			result = f'{"ok  " if ok else "BLANK"} std {std:5.1f}'
		except Exception as e:  # report and continue with the next provider
			# only our own RuntimeError messages are safe to print: others can carry a keyed URL
			ok, result = False, f'FAIL {type(e).__name__}' + (f': {e}' if isinstance(e, RuntimeError) else '')
		failed += not ok
		print(f'{p.name:28s} {result}  {time.monotonic() - started:5.1f}s', flush=True)
	print(f'{failed} provider(s) failed')
	return 1 if failed else 0


if __name__ == '__main__':
	raise SystemExit(main())
