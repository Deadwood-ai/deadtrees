from pathlib import Path
from typing import Tuple, Optional, List
import xarray as xr
import numpy as np
from rasterio import crs, warp
from shared.logger import logger
from shared.models import PhenologyMetadata
from shared.settings import settings

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


def get_phenology_curve(lat: float, lon: float) -> Optional[List[int]]:
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

		# Get the nearest pixel
		ds_nearest = ds.sel(x=x, y=y, method='nearest')

		# Extract phenology data
		pheno = ds_nearest.phenology.values[0][0]
		is_nan = ds_nearest.nan_mask.values[0][0]

		if is_nan:
			logger.debug(f'No phenology data available for coordinates ({lat}, {lon})')
			return None

		# Convert to list of integers
		phenology_curve = pheno.astype(int).tolist()

		if len(phenology_curve) != 366:
			logger.warning(f'Unexpected phenology curve length: {len(phenology_curve)}')
			return None

		return phenology_curve

	except Exception as e:
		logger.error(f'Error getting phenology data for ({lat}, {lon}): {str(e)}')
		return None


def get_phenology_metadata(lat: float, lon: float) -> Optional[PhenologyMetadata]:
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
		curve = get_phenology_curve(lat, lon)
		if curve is None:
			return None

		# Create metadata object
		return PhenologyMetadata(phenology_curve=curve)

	except Exception as e:
		logger.error(f'Error creating phenology metadata: {str(e)}')
		return None
