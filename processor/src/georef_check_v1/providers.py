"""Registry of reference imagery for the georeferencing check.

Each provider is one imagery source the drone image is matched against. A
provider is used for a dataset when its coverage (lon/lat boxes; empty means
worldwide) contains the footprint centre and, for keyed providers, its key is
set. `group` names the evidence group: providers serving the same imagery
share a group, so they never count as independent confirmation of each other.
Official orthophotos get their own group unless Esri World Imagery shows the
same acquisition there (then they join the `esri` group).

Kinds:
- xyz: Web-Mercator tiles, `url` with {z}/{x}/{y} ({-y} for TMS row order,
  {zz} for a zero-padded zoom, {q} for a Bing quadkey);
  WMTS REST/KVP and ArcGIS tile endpoints in GoogleMapsCompatible use this too
- wms: OGC WMS GetMap for the exact grid extent (EPSG:3857, or EPSG:4326)
- arcgis_export: ArcGIS MapServer/ImageServer export for the exact grid extent

The entries live in providers.json, one per line. Every keyless entry was
fetched live at a site inside its coverage before it was added;
scripts/check_georef_providers.py re-checks them. Entries marked `restricted`
work without sign-up but their terms are unclear or restrict automated use
(each `licence` says how); they can be switched off as a group.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

LonLatBox = tuple[float, float, float, float]  # west, south, east, north


@dataclass(frozen=True)
class Provider:
	name: str
	group: str
	kind: str  # xyz | wms | arcgis_export
	url: str
	coverage: tuple[LonLatBox, ...] = ()  # empty: worldwide
	max_zoom: int = 19
	key_setting: str | None = None  # shared.settings attribute holding the API key
	key_param: str = 'key'
	wms_layers: str = ''
	wms_version: str = '1.3.0'
	wms_crs: str = 'EPSG:3857'
	tile_crs: str = 'EPSG:3857'  # xyz tile grid; EPSG:3395 for ellipsoidal-Mercator tiles
	image_format: str = 'image/jpeg'
	attribution: str = ''
	licence: str = ''
	# keyless but with unclear or restrictive terms for automated use; on by
	# decision (2026-10-02), off with GEOREF_SKIP_RESTRICTED_PROVIDERS
	restricted: bool = False
	check_lonlat: tuple[float, float] | None = None  # a covered land site for the live check

	def covers(self, lon: float, lat: float) -> bool:
		return not self.coverage or any(w <= lon <= e and s <= lat <= n for w, s, e, n in self.coverage)


def _load() -> tuple[Provider, ...]:
	rows = json.loads((Path(__file__).with_name('providers.json')).read_text())
	return tuple(
		Provider(
			**{
				**r,
				'coverage': tuple(tuple(b) for b in r.get('coverage', ())),
				'check_lonlat': tuple(r['check_lonlat']),
			}
		)
		for r in rows
	)


REGISTRY: tuple[Provider, ...] = _load()
ESRI = next(p for p in REGISTRY if p.name == 'esri')
