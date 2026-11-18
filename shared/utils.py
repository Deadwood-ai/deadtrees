from pathlib import Path
from rasterio.env import Env
import rasterio
import pyproj
from rasterio.warp import transform, transform_bounds
from shared.logger import logger

_WGS84 = pyproj.Geod(ellps='WGS84')


def get_transformed_bounds(file_path: Path):
	"""Get transformed bounds from GeoTIFF"""
	with Env(GTIFF_SRS_SOURCE='EPSG'):
		with rasterio.open(str(file_path), 'r') as src:
			try:
				return transform_bounds(src.crs, 'EPSG:4326', *src.bounds)
			except Exception as e:
				logger.error(f'No CRS found for {file_path}: {e}')
				return None


def ground_resolution_cm(file_path: Path) -> float | None:
	"""Ground size of one pixel in cm, measured geodesically at the raster centre.

	The pixel's width and height are taken to WGS84, so any CRS unit (metres, feet,
	degrees, web mercator) gives ground distance. Rasters in a local CRS cannot be
	placed on the globe and use the CRS's linear unit. None when neither works.
	"""
	with Env(GTIFF_SRS_SOURCE='EPSG'):
		with rasterio.open(str(file_path), 'r') as src:
			if src.crs is None:
				return None
			res_x, res_y = src.res
			x, y = src.xy(src.height // 2, src.width // 2)
			try:
				lons, lats = transform(src.crs, 'EPSG:4326', [x, x + res_x, x], [y, y, y + res_y])
			except Exception as e:
				axes = pyproj.CRS.from_wkt(src.crs.to_wkt()).axis_info
				if not axes or axes[0].unit_conversion_factor is None:
					logger.warning(f'No ground resolution for {file_path}: {e}')
					return None
				return round((res_x + res_y) / 2 * axes[0].unit_conversion_factor * 100, 1)
	_, _, width = _WGS84.inv(lons[0], lats[0], lons[1], lats[1])
	_, _, height = _WGS84.inv(lons[0], lats[0], lons[2], lats[2])
	return round((width + height) / 2 * 100, 1)


def format_bbox_string(bbox: tuple) -> str | None:
	"""Format bbox tuple into PostGIS box string"""
	if bbox and len(bbox) == 4:
		return f'BOX({bbox[0]} {bbox[1]},{bbox[2]} {bbox[3]})'
	return None
