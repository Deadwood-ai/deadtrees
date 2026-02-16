"""
DTE Maps Statistics Endpoint

Provides time-series statistics (forest cover, deadwood) aggregated within
a user-drawn polygon. Reads data directly from COG files on the local filesystem.
"""

import re
import logging
from pathlib import Path
from typing import Optional

import numpy as np
import rasterio
from rasterio.mask import mask as rasterio_mask
from pyproj import Geod
from shapely.geometry import shape, mapping
from shapely.ops import transform
from pyproj import Transformer
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from shared.settings import settings


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/dte-stats", tags=["dte-stats"])

# Max polygon area in km²
MAX_AREA_KM2 = 1000.0

# Pixel resolution (~19.1m in EPSG:3857, from actual COG metadata)
PIXEL_SIZE_M = 19.109257
PIXEL_AREA_M2 = PIXEL_SIZE_M * PIXEL_SIZE_M  # ~365.16 m²
PIXEL_AREA_HA = PIXEL_AREA_M2 / 10_000  # ~0.03652 ha

# COG filename pattern
COG_PATTERN = re.compile(
	r"run_v1004_v1000_crop_half_fold_None_checkpoint_199_(deadwood|forest)_(\d{4})\.cog\.tif"
)


# --- Request / Response Models ---

class PolygonStatsRequest(BaseModel):
	"""Request body with a GeoJSON polygon in EPSG:4326."""
	polygon: dict = Field(
		...,
		description="GeoJSON Polygon geometry in EPSG:4326",
		json_schema_extra={
			"example": {
				"type": "Polygon",
				"coordinates": [[[10.64, 51.77], [10.70, 51.77], [10.70, 51.80], [10.64, 51.80], [10.64, 51.77]]]
			}
		}
	)


class YearStats(BaseModel):
	"""Statistics for a single year."""
	year: int
	deadwood_mean_pct: Optional[float] = Field(None, description="Mean deadwood fractional cover (%)")
	deadwood_pixel_count: Optional[int] = Field(None, description="Number of valid deadwood pixels")
	deadwood_area_ha: Optional[float] = Field(None, description="Deadwood-weighted area in hectares")
	forest_mean_pct: Optional[float] = Field(None, description="Mean forest fractional cover (%)")
	forest_pixel_count: Optional[int] = Field(None, description="Number of valid forest pixels")
	forest_area_ha: Optional[float] = Field(None, description="Forest-weighted area in hectares")


class CoverageBounds(BaseModel):
	"""Geographic bounds of the available COG data in EPSG:4326."""
	min_lon: float
	min_lat: float
	max_lon: float
	max_lat: float


class PolygonStatsResponse(BaseModel):
	"""Response with time-series statistics."""
	polygon_area_km2: float = Field(..., description="Geodesic area of the polygon in km²")
	available_years: list[int] = Field(..., description="Years with data")
	stats: list[YearStats] = Field(..., description="Per-year statistics")
	coverage_bounds: Optional[CoverageBounds] = Field(None, description="Geographic bounds of available data")


# --- Utility functions ---

def compute_geodesic_area_km2(geojson_polygon: dict) -> float:
	"""Compute geodesic area of a GeoJSON polygon (EPSG:4326) in km²."""
	geod = Geod(ellps="WGS84")
	geom = shape(geojson_polygon)
	# geod.geometry_area_perimeter returns (area_m2, perimeter_m)
	area_m2, _ = geod.geometry_area_perimeter(geom)
	return abs(area_m2) / 1_000_000


def discover_available_cogs(maps_dir: Path) -> dict[str, dict[int, Path]]:
	"""
	Scan the dte_maps directory and return available COGs grouped by type and year.
	Returns: {"deadwood": {2020: Path(...), ...}, "forest": {2020: Path(...), ...}}
	"""
	result: dict[str, dict[int, Path]] = {"deadwood": {}, "forest": {}}

	if not maps_dir.exists():
		logger.warning(f"DTE maps directory does not exist: {maps_dir}")
		return result

	for f in maps_dir.iterdir():
		m = COG_PATTERN.match(f.name)
		if m:
			cog_type = m.group(1)
			year = int(m.group(2))
			result[cog_type][year] = f

	return result


def compute_stats_for_cog(
	cog_path: Path,
	polygon_3857: dict,
) -> tuple[float, int, float]:
	"""
	Compute statistics for a single COG file within a polygon.

	Args:
		cog_path: Path to the COG file
		polygon_3857: GeoJSON polygon in EPSG:3857

	Returns:
		(mean_pct, pixel_count, weighted_area_ha)
	"""
	with rasterio.open(str(cog_path)) as src:
		# Mask the raster with the polygon
		out_image, out_transform = rasterio_mask(
			src,
			[polygon_3857],
			crop=True,
			nodata=0,
			filled=True,
		)

		# Get the first band
		band = out_image[0].astype(np.float64)

		# Valid pixels (nodata=0, so values > 0 are valid)
		valid_mask = band > 0
		valid_count = int(np.sum(valid_mask))

		if valid_count == 0:
			return 0.0, 0, 0.0

		# Normalize 0-255 to 0-1 fractional cover
		fractional = band[valid_mask] / 255.0

		# Mean percentage (0-100)
		mean_pct = float(np.mean(fractional) * 100)

		# Weighted area: sum of fractional values × pixel area
		weighted_area_ha = float(np.sum(fractional) * PIXEL_AREA_HA)

		return mean_pct, valid_count, weighted_area_ha


def transform_polygon_4326_to_3857(geojson_polygon: dict) -> dict:
	"""Transform a GeoJSON polygon from EPSG:4326 to EPSG:3857."""
	transformer = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
	geom = shape(geojson_polygon)
	geom_3857 = transform(transformer.transform, geom)
	return mapping(geom_3857)


def compute_coverage_bounds(cog_map: dict[str, dict[int, Path]]) -> Optional[CoverageBounds]:
	"""Compute the union of all COG extents in EPSG:4326."""
	transformer = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
	min_x, min_y, max_x, max_y = float("inf"), float("inf"), float("-inf"), float("-inf")
	found = False

	for type_cogs in cog_map.values():
		for path in type_cogs.values():
			try:
				with rasterio.open(str(path)) as src:
					b = src.bounds
					min_x = min(min_x, b.left)
					min_y = min(min_y, b.bottom)
					max_x = max(max_x, b.right)
					max_y = max(max_y, b.top)
					found = True
			except Exception:
				continue

	if not found:
		return None

	lon_min, lat_min = transformer.transform(min_x, min_y)
	lon_max, lat_max = transformer.transform(max_x, max_y)
	return CoverageBounds(
		min_lon=round(lon_min, 6),
		min_lat=round(lat_min, 6),
		max_lon=round(lon_max, 6),
		max_lat=round(lat_max, 6),
	)


# --- Endpoint ---

@router.post("/polygon", response_model=PolygonStatsResponse)
def get_polygon_stats(request: PolygonStatsRequest):
	"""
	Compute time-series forest cover and deadwood statistics within a polygon.

	The polygon must be GeoJSON in EPSG:4326. Maximum area is 1000 km².
	Returns per-year statistics including mean percentage, pixel count,
	and area-weighted coverage in hectares.
	"""
	polygon = request.polygon

	# Validate polygon type
	if polygon.get("type") != "Polygon":
		raise HTTPException(status_code=400, detail="Geometry must be a Polygon")

	coords = polygon.get("coordinates")
	if not coords or len(coords) == 0 or len(coords[0]) < 4:
		raise HTTPException(status_code=400, detail="Polygon must have at least 3 vertices")

	# Compute geodesic area and validate
	area_km2 = compute_geodesic_area_km2(polygon)
	if area_km2 > MAX_AREA_KM2:
		raise HTTPException(
			status_code=400,
			detail=f"Polygon area ({area_km2:.2f} km²) exceeds maximum ({MAX_AREA_KM2} km²)"
		)

	if area_km2 < 0.0001:
		raise HTTPException(status_code=400, detail="Polygon is too small")

	# Discover available COGs
	maps_dir = settings.dte_maps_path
	cog_map = discover_available_cogs(maps_dir)

	all_years = sorted(set(list(cog_map["deadwood"].keys()) + list(cog_map["forest"].keys())))

	if not all_years:
		raise HTTPException(
			status_code=404,
			detail=f"No DTE map COGs found in {maps_dir}"
		)

	# Transform polygon to EPSG:3857 for raster operations
	polygon_3857 = transform_polygon_4326_to_3857(polygon)

	# Log polygon bounds for debugging
	poly_geom = shape(polygon_3857)
	pb = poly_geom.bounds
	logger.info(f"Polygon bounds (3857): minx={pb[0]:.1f}, miny={pb[1]:.1f}, maxx={pb[2]:.1f}, maxy={pb[3]:.1f}")

	# Compute stats for each year
	stats: list[YearStats] = []

	for year in all_years:
		year_stats = YearStats(year=year)

		# Deadwood
		if year in cog_map["deadwood"]:
			try:
				cog_path = cog_map["deadwood"][year]
				with rasterio.open(str(cog_path)) as src:
					cb = src.bounds
					logger.info(f"COG deadwood {year} bounds: left={cb.left:.1f}, bottom={cb.bottom:.1f}, right={cb.right:.1f}, top={cb.top:.1f}")
				mean_pct, count, area_ha = compute_stats_for_cog(
					cog_path, polygon_3857
				)
				year_stats.deadwood_mean_pct = round(mean_pct, 2)
				year_stats.deadwood_pixel_count = count
				year_stats.deadwood_area_ha = round(area_ha, 4)
				logger.info(f"Deadwood {year}: mean={mean_pct:.2f}%, count={count}, area={area_ha:.4f}ha")
			except Exception as e:
				logger.error(f"Error computing deadwood stats for {year}: {e}", exc_info=True)

		# Forest
		if year in cog_map["forest"]:
			try:
				cog_path = cog_map["forest"][year]
				with rasterio.open(str(cog_path)) as src:
					cb = src.bounds
					logger.info(f"COG forest {year} bounds: left={cb.left:.1f}, bottom={cb.bottom:.1f}, right={cb.right:.1f}, top={cb.top:.1f}")
				mean_pct, count, area_ha = compute_stats_for_cog(
					cog_path, polygon_3857
				)
				year_stats.forest_mean_pct = round(mean_pct, 2)
				year_stats.forest_pixel_count = count
				year_stats.forest_area_ha = round(area_ha, 4)
				logger.info(f"Forest {year}: mean={mean_pct:.2f}%, count={count}, area={area_ha:.4f}ha")
			except Exception as e:
				logger.error(f"Error computing forest stats for {year}: {e}", exc_info=True)

		stats.append(year_stats)

	return PolygonStatsResponse(
		polygon_area_km2=round(area_km2, 4),
		available_years=all_years,
		stats=stats,
	)
