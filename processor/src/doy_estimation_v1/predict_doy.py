"""One ortho -> calibrated acquisition day-of-year distribution + assessment.

An ortho whose flight-year window has S2 weeks is dated by the S2 model, all
others by the no-S2 model (research deploy.py). S2 problems (no block, block
not processed yet, flight outside the archive, S3/blocks DB unreachable)
never fail the stage: they fall back to the no-S2 model and are recorded.
"""

from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from shared.asset_manifest import DOY_ESTIMATION_MODEL_DIR_NAME
from shared.settings import ASSETS_DIR

from .assessment import DoyAssessment, assess
from .embed import load_backbone
from .features import ortho_on_grid, ortho_views, s2_series, s2_window, site_inputs
from .model import DoyModelBundle, load_bundle, predict_distribution
from .sentinel2 import S2Lookup, fetch_cube

MODEL_DIR = ASSETS_DIR / 'models' / DOY_ESTIMATION_MODEL_DIR_NAME


@dataclass
class DoyEstimate:
	model_version: str
	model_type: str  # s2 | nos2
	probabilities: np.ndarray  # (365,) calibrated, sums to 1
	assessment: DoyAssessment
	s2: S2Lookup
	inputs: dict  # facts about the inputs, stored with the estimate


def _device() -> str:
	import torch

	return 'cuda' if torch.cuda.is_available() else 'cpu'


@lru_cache(maxsize=1)
def _models(device: str) -> tuple[DoyModelBundle, object]:
	bundle = load_bundle(MODEL_DIR, device)
	return bundle, load_backbone(bundle.backbone_path, bundle.backbone_name, device)


def estimate_acquisition_date(
	cog_path: str,
	dataset_id: int,
	lat: float,
	lon: float,
	year: int,
	month: int | None,
	day: int | None,
	aoi_4326: dict | None,
	bbox_4326: tuple,
	biome_name: str | None,
) -> DoyEstimate:
	device = _device()
	bundle, embed = _models(device)

	views = ortho_views(cog_path, dataset_id, lat, aoi_4326)
	emb = embed(views.patches)

	window, has_match = {}, False
	cube, lookup = fetch_cube(aoi_4326, bbox_4326, year)
	if cube is not None:
		g10, g10_valid = ortho_on_grid(cog_path, views, lat, cube.grid)
		window = s2_window(s2_series(cube, g10, g10_valid), year)
		has_match = bool(window.get('has_match', False))
		if not window:
			lookup.status = 'outside_archive'
	model_type = 's2' if window else 'nos2'

	p, cal = predict_distribution(
		bundle.ensembles[model_type],
		site_inputs(emb, window, lat, lon, year, views.gsd),
		biome_name,
		device,
	)
	return DoyEstimate(
		model_version=bundle.version,
		model_type=model_type,
		probabilities=p,
		assessment=assess(p, year, month, day),
		s2=lookup,
		inputs={
			'flight_year': year,
			'lat': lat,
			'lon': lon,
			'gsd_m': round(views.gsd, 4),
			'n_patches': int(len(views.patches)),
			'used_aoi': aoi_4326 is not None,
			'biome_name': biome_name,
			's2_weeks': int(len(window.get('f', []))),
			's2_has_match': has_match,
			'calibration': cal,
			'device': device,
		},
	)
