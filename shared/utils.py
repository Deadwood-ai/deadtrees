from pathlib import Path
from rasterio.env import Env
import rasterio
from rasterio.warp import transform_bounds
from shared.logger import logger


def get_transformed_bounds(file_path: Path):
	"""Get transformed bounds from GeoTIFF"""
	with Env(GTIFF_SRS_SOURCE='EPSG'):
		with rasterio.open(str(file_path), 'r') as src:
			try:
				return transform_bounds(src.crs, 'EPSG:4326', *src.bounds)
			except Exception as e:
				logger.error(f'No CRS found for {file_path}: {e}')
				return None


def format_bbox_string(bbox: tuple) -> str | None:
	"""Format bbox tuple into PostGIS box string"""
	if bbox and len(bbox) == 4:
		return f'BOX({bbox[0]} {bbox[1]},{bbox[2]} {bbox[3]})'
	return None
