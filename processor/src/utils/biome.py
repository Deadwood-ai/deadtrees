import math
from pathlib import Path
from typing import Tuple, Optional
import geopandas as gpd
from shapely.geometry import Point, box
from shared.logger import logger
from shared.settings import settings
from shared.logging import LogContext, LogCategory

# Define the path to the biome database
BIOME_PATH = Path(settings.BIOME_DATA_PATH)
BIOME_DICT = settings.BIOME_DICT

# Small islands and coastlines are drawn coarsely in the WWF ecoregions, so a
# point on land can sit tens of kilometres outside the nearest polygon.
MAX_BIOME_DISTANCE_M = 50_000


def get_biome_path():
	"""Get biome data path, checking if it exists"""
	if not BIOME_PATH.exists():
		raise FileNotFoundError(
			f'Biome data file not found at {BIOME_PATH}. '
			'Please run `make download-assets` to download required data files.'
		)
	return BIOME_PATH


def _search_area(point: Point) -> box:
	"""Degree box that contains every location within MAX_BIOME_DISTANCE_M of the point."""
	d_lat = MAX_BIOME_DISTANCE_M / 110_000
	d_lon = min(180.0, d_lat / max(math.cos(math.radians(point.y)), 0.01))
	return box(point.x - d_lon, point.y - d_lat, point.x + d_lon, point.y + d_lat)


def get_biome_data(
	point: Tuple[float, float], token: str = None, dataset_id: int = None, user_id: str = None
) -> Tuple[Optional[str], Optional[int]]:
	"""
	Returns the biome of the nearest WWF ecoregion within MAX_BIOME_DISTANCE_M.

	Lakes (98) and rock and ice (99) are not biomes and are skipped, so a point
	in one of them gets the nearest surrounding biome.

	Args:
	    point: Tuple of (longitude, latitude)

	Returns:
	    Tuple of (biome_name, biome_id)
	"""
	try:
		point_geom = Point(point[0], point[1])
		gdf = gpd.read_file(BIOME_PATH, mask=_search_area(point_geom), columns=['BIOME', 'geometry'])
		gdf = gdf[gdf['BIOME'].isin(list(BIOME_DICT))]
		if gdf.empty:
			return None, None

		gdf = gdf.set_crs(gdf.crs or 'EPSG:4326', allow_override=True)
		metric_crs = gdf.estimate_utm_crs()
		point_m = gpd.GeoSeries([point_geom], crs='EPSG:4326').to_crs(metric_crs).iloc[0]
		distances = gdf.to_crs(metric_crs).geometry.distance(point_m)
		nearest = distances.idxmin()
		if distances[nearest] > MAX_BIOME_DISTANCE_M:
			return None, None

		biome_id = int(gdf.loc[nearest, 'BIOME'])
		return BIOME_DICT[biome_id], biome_id

	except Exception as e:
		logger.error(
			f'Error getting biome data: {str(e)}',
			LogContext(
				category=LogCategory.METADATA,
				dataset_id=dataset_id,
				user_id=user_id,
				token=token,
				extra={'error': str(e)},
			),
		)
		return None, None
