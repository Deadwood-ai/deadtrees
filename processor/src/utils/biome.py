from pathlib import Path
from typing import Tuple, Optional
import geopandas as gpd
from shapely.geometry import Point
from shared.logger import logger
from shared.settings import settings

# Define the path to the biome database
BIOME_PATH = Path(settings.BIOME_DATA_PATH)
BIOME_DICT = settings.BIOME_DICT


def get_biome_path():
	"""Get biome data path, checking if it exists"""
	if not BIOME_PATH.exists():
		raise FileNotFoundError(
			f'Biome data file not found at {BIOME_PATH}. '
			'Please run `make download-assets` to download required data files.'
		)
	return BIOME_PATH


def get_biome_data(point: Tuple[float, float]) -> Tuple[Optional[str], Optional[int]]:
	"""
	Returns biome name and ID for a given point.

	Args:
	    point: Tuple of (longitude, latitude)

	Returns:
	    Tuple of (biome_name, biome_id)
	"""
	try:
		# Create Point object (lon, lat)
		point_geom = Point(point[0], point[1])

		# Read only necessary columns with spatial filter
		columns = ['BIOME', 'geometry']
		gdf = gpd.read_file(
			BIOME_PATH,
			mask=point_geom.buffer(0.1),
			columns=columns,
		)

		if not gdf.empty:
			# Find intersecting polygons
			mask = gdf.geometry.intersects(point_geom.buffer(0.1))
			if mask.any():
				intersecting = gdf[mask]
				if len(intersecting) == 1:
					# If only one intersection, take it directly
					row = intersecting.iloc[0]
				else:
					# Multiple intersections, find the closest one
					distances = intersecting.geometry.distance(point_geom)
					row = intersecting.iloc[distances.argmin()]
				
				biome_id = int(row['BIOME'])
				biome_name = settings.BIOME_DICT[biome_id]

				return biome_name, biome_id

		return None, None

	except Exception as e:
		logger.error(f'Error getting biome data: {str(e)}')
		return None, None
