"""Run the georeferencing check for one orthophoto."""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field
from datetime import date

import numpy as np

from .evidence import RULES, RULES_VERSION, Assessment, ReferenceEvidence, combine, footprint_samples, measure_reference
from .matcher import match
from .references import fetch_references
from .source import read_source

MODEL_VERSION = 'romav2.0.1'
NULL_LINE_DEG = 0.005  # a footprint centred this close to the equator or prime meridian


@dataclass
class GeorefCheck:
	assessment: Assessment
	references: list[ReferenceEvidence]
	reference_errors: dict
	used_aoi: bool
	grid: dict
	seconds: float
	gross: str | None = None  # reason when coordinates look lost, not just shifted
	details: dict = field(default_factory=dict)

	@property
	def decision(self) -> str:
		return self.assessment.decision


def _to_lonlat(pairs: list[list[float]], grid) -> list[list[float]]:
	if not pairs:
		return []
	p = np.asarray(pairs)
	lon_a, lat_a = grid.lonlat(p[:, :2])
	lon_b, lat_b = grid.lonlat(p[:, 2:])
	return np.round(np.column_stack((lon_a, lat_a, lon_b, lat_b)), 7).tolist()


def run_georef_check(cog_path: str, aoi_4326: dict | None, flight: date | None) -> GeorefCheck:
	started = time.monotonic()
	source = read_source(cog_path, aoi_4326)
	grid = source.grid
	centre = grid.lonlat(np.array([[grid.width / 2, grid.height / 2]]))
	lon, lat = float(centre[0][0]), float(centre[1][0])
	footprint, edge = footprint_samples(source.mask)
	refs, errors = fetch_references(grid, (lon, lat), flight)
	evidence = []
	for ref in refs:
		a, b, scores = match(source.image, ref.image)
		e = measure_reference(ref.provider, a, b, scores, footprint, edge, grid)
		e.sample_pairs = _to_lonlat(e.sample_pairs, grid)
		evidence.append(e)
	assessment = combine(evidence)
	gross = None
	if assessment.decision == 'uncertain' and not any(e.matrix for e in evidence):
		if abs(lat) < NULL_LINE_DEG or abs(lon) < NULL_LINE_DEG:
			# nothing matches and the image sits on the equator or the prime
			# meridian: its coordinates were lost (e.g. a zero latitude)
			gross = 'on_null_line'
			assessment = Assessment('poor', 'gross', gross, None, 0, 0.0, 0.0)
	details = {
		'rules_version': RULES_VERSION,
		'rules': asdict(RULES),
		'model_version': MODEL_VERSION,
		'native_m_per_px': round(source.native_m_per_px, 4),
		'grid_m_per_px': round(grid.metres_per_pixel(), 4),
		'centre_lonlat': [round(lon, 6), round(lat, 6)],
		'references': {r.provider: {'zoom': r.zoom, 'capture_date': r.capture_date, 'tile_url': r.tile_url} for r in refs},
	}
	return GeorefCheck(
		assessment=assessment,
		references=evidence,
		reference_errors=errors,
		used_aoi=source.used_aoi,
		grid={'bounds_3857': list(grid.bounds), 'width': grid.width, 'height': grid.height},
		seconds=round(time.monotonic() - started, 1),
		gross=gross,
		details=details,
	)
