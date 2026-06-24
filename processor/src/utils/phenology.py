from pathlib import Path
from typing import Tuple, Optional, List
import xarray as xr
import numpy as np
from rasterio import crs, warp
from shared.logger import logger
from shared.models import PhenologyMetadata
from shared.settings import settings
from shared.logging import LogContext, LogCategory

# Dataset path

# MODIS Sinusoidal projection
MODIS_CRS = crs.CRS.from_string("""PROJCS["unnamed",
GEOGCS["Unknown datum based upon the custom spheroid", 
DATUM["Not specified (based on custom spheroid)", 
SPHEROID["Custom spheroid",6371007.181,0]], 
PRIMEM["Greenwich",0],
UNIT["degree",0.0174532925199433]],
PROJECTION["Sinusoidal"], 
PARAMETER["longitude_of_center",0], 
PARAMETER["false_easting",0], 
PARAMETER["false_northing",0], 
UNIT["Meter",1]]""")


def get_phenology_path() -> Path:
	"""Get phenology data path, checking if it exists"""

	if not Path(settings.PHENOLOGY_DATA_PATH).exists():
		raise FileNotFoundError(
			f'Phenology data file not found at {settings.PHENOLOGY_DATA_PATH}. Please ensure the dataset is available.'
		)
	return Path(settings.PHENOLOGY_DATA_PATH)


def _find_nearest_valid_index(ds: xr.Dataset, x: float, y: float) -> Optional[Tuple[int, int]]:
	"""
	Find the (y, x) integer index of the nearest non-masked phenology pixel.

	The phenology grid is gap-filled in time (each valid pixel has a full curve) but not in
	space: ~87% of pixels are masked (ocean, projection corners, and land pixels where MODIS
	derived no cycle). A dataset centroid near a coast/island can land on a masked pixel even
	though valid phenology exists nearby. To guarantee every dataset gets a curve, when the
	nearest pixel is masked we fall back to the globally nearest valid pixel, regardless of how
	far away it is.

	Args:
	    ds: Open phenology dataset (dims y, x, day) with a boolean ``nan_mask`` (True = no data).
	    x: Target x coordinate in MODIS sinusoidal meters.
	    y: Target y coordinate in MODIS sinusoidal meters.

	Returns:
	    (yi, xi) of the nearest valid pixel, or None only if the grid has no valid pixels at all.
	"""
	xs = ds.x.values
	ys = ds.y.values

	xi = int(np.abs(xs - x).argmin())
	yi = int(np.abs(ys - y).argmin())

	# Fast path: nearest pixel already has data (true for ~94% of datasets).
	if not bool(ds.nan_mask.isel(y=yi, x=xi).values):
		return yi, xi

	# Fallback: load the small (~7 MB) nan_mask and pick the globally nearest valid pixel.
	mask = ds.nan_mask.values
	valid_rows, valid_cols = np.where(~mask)
	if valid_rows.size == 0:
		return None

	dy = valid_rows - yi
	dx = valid_cols - xi
	nearest = int(np.argmin(dy * dy + dx * dx))
	return int(valid_rows[nearest]), int(valid_cols[nearest])


def get_phenology_curve(
	lat: float, lon: float, token: str = None, dataset_id: int = None, user_id: str = None
) -> Optional[List[int]]:
	"""
	Get the phenology curve for a given latitude and longitude.

	Args:
	    lat: Latitude in decimal degrees
	    lon: Longitude in decimal degrees

	Returns:
	    List of 366 integers (0-255) or None if no data available
	"""
	try:
		# Transform lat/lon to MODIS coordinates
		x, y = warp.transform(crs.CRS.from_epsg(4326), MODIS_CRS, [lon], [lat])

		# Open the dataset
		ds = xr.open_zarr(get_phenology_path())

		# Get the nearest valid pixel, falling back to the globally nearest valid pixel when the
		# nearest pixel is masked (e.g. coastal/island centroids). Only None if the grid is empty.
		index = _find_nearest_valid_index(ds, x[0], y[0])

		if index is None:
			logger.debug(
				f'No phenology data available for coordinates ({lat}, {lon})',
				LogContext(category=LogCategory.METADATA, dataset_id=dataset_id, user_id=user_id, token=token),
			)
			return None

		yi, xi = index
		pheno = ds.phenology.isel(y=yi, x=xi).values

		# Convert to list of integers
		phenology_curve = pheno.astype(int).tolist()

		if len(phenology_curve) != 366:
			logger.warning(
				f'Unexpected phenology curve length: {len(phenology_curve)}',
				LogContext(category=LogCategory.METADATA, dataset_id=dataset_id, user_id=user_id, token=token),
			)
			return None

		return phenology_curve

	except Exception as e:
		logger.error(
			f'Error getting phenology data for ({lat}, {lon}): {str(e)}',
			LogContext(
				category=LogCategory.METADATA,
				dataset_id=dataset_id,
				user_id=user_id,
				token=token,
				extra={'error': str(e)},
			),
		)
		return None


def get_phenology_metadata(
	lat: float, lon: float, token: str = None, dataset_id: int = None, user_id: str = None
) -> Optional[PhenologyMetadata]:
	"""
	Get phenology metadata for a location.

	Args:
	    lat: Latitude in decimal degrees
	    lon: Longitude in decimal degrees

	Returns:
	    PhenologyMetadata object or None if no data available
	"""
	try:
		# Get phenology curve
		curve = get_phenology_curve(lat, lon, token=token, dataset_id=dataset_id, user_id=user_id)
		if curve is None:
			return None

		# Create metadata object
		return PhenologyMetadata(phenology_curve=curve)

	except Exception as e:
		logger.error(
			f'Error creating phenology metadata: {str(e)}',
			LogContext(
				category=LogCategory.METADATA,
				dataset_id=dataset_id,
				user_id=user_id,
				token=token,
				extra={'error': str(e)},
			),
		)
		return None
