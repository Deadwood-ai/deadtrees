import json

import cv2
import geopandas as gpd
import numpy as np
import rasterio
import rasterio.warp
import shapely
import utm
from rasterio.vrt import WarpedVRT
from shapely.affinity import affine_transform
from shapely.geometry import Polygon


def get_utm_string_from_latlon(lat, lon):
	zone = utm.from_latlon(lat, lon)
	utm_code = 32600 + zone[2]
	if lat < 0:
		utm_code -= 100

	return f'EPSG:{utm_code}'


def merge_polygons(contours, hierarchy):
	# https://docs.opencv.org/4.x/d9/d8b/tutorial_py_contours_hierarchy.html
	# hierarchy structure: [next, prev, first_child, parent]
	polygons = []

	idx = 0
	while idx != -1:
		contour = np.squeeze(contours[idx])
		if len(contour) > 2:
			holes = []
			child_idx = hierarchy[idx][2]
			if child_idx != -1:
				while child_idx != -1:
					child = np.squeeze(contours[child_idx])
					if len(child) > 2:
						holes.append(child)
					child_idx = hierarchy[child_idx][0]

			polygons.append(Polygon(shell=contour, holes=holes))

		idx = hierarchy[idx][0]

	return polygons


def mask_to_polygons(mask, dataset_reader):
	"""Convert a binary mask into polygons in the dataset CRS."""
	contours, hierarchy = cv2.findContours(
		mask.astype(np.uint8).copy(),
		mode=cv2.RETR_CCOMP,
		method=cv2.CHAIN_APPROX_SIMPLE,
	)

	if hierarchy is None or len(hierarchy) == 0:
		return []

	hierarchy = hierarchy[0]
	polygons = merge_polygons(contours, hierarchy)

	transform = dataset_reader.transform
	transform_matrix = (transform.a, transform.b, transform.d, transform.e, transform.c, transform.f)
	return [affine_transform(poly, transform_matrix) for poly in polygons]


def save_poly(filename, polygons, crs):
	"""Save polygons to a file in the given CRS."""
	gpd.GeoDataFrame(geometry=polygons, crs=crs).to_file(filename)


def image_reprojector(input_tif, min_res=0, max_res=1e9):
	dataset = rasterio.open(input_tif)
	centroid = dataset.lnglat()
	utm_crs = get_utm_string_from_latlon(centroid[1], centroid[0])

	default_transform, width, height = rasterio.warp.calculate_default_transform(
		dataset.crs, utm_crs, dataset.width, dataset.height, *dataset.bounds
	)

	orig_res = default_transform.a
	target_res = None

	if orig_res < min_res:
		target_res = min_res
		print(
			f'Original resolution ({orig_res}) is smaller than minimum resolution ({min_res}). Reprojecting to minimum resolution.'
		)
	if orig_res > max_res:
		target_res = max_res
		print(
			f'Original resolution ({orig_res}) is larger than maximum resolution ({max_res}). Reprojecting to maximum resolution.'
		)

	if target_res is not None:
		default_transform, width, height = rasterio.warp.calculate_default_transform(
			dataset.crs,
			utm_crs,
			dataset.width,
			dataset.height,
			*dataset.bounds,
			resolution=target_res,
		)

	return WarpedVRT(
		dataset,
		crs=utm_crs,
		transform=default_transform,
		width=width,
		height=height,
		dtype='uint8',
		nodata=0,
	)


def reproject_polygons(polygons, src_crs, dst_crs):
	"""Reproject polygons from src_crs to dst_crs."""
	reprojected = rasterio.warp.transform_geom(src_crs, dst_crs, polygons)
	if isinstance(reprojected, list):
		return shapely.from_geojson([json.dumps(item) for item in reprojected])
	return shapely.from_geojson(json.dumps(reprojected))


def filter_polygons_by_area(polygons, min_area):
	"""Filter polygons and interior rings below the minimum area."""
	filtered = []
	for polygon in polygons:
		exterior = polygon.exterior
		filtered_holes = [hole for hole in polygon.interiors if Polygon(hole).area >= min_area]
		filtered_polygon = Polygon(exterior, filtered_holes)
		if filtered_polygon.area >= min_area:
			filtered.append(polygon)

	print(f'Filtered {len(polygons) - len(filtered)} polygons by minimum area of {min_area}m2.')
	return filtered


def polygons_to_multipolygon_geojson(polygons):
	"""Convert shapely polygons into a GeoJSON MultiPolygon payload."""
	return {
		'type': 'MultiPolygon',
		'coordinates': [
			[[[float(x), float(y)] for x, y in poly.exterior.coords]]
			+ [[[float(x), float(y)] for x, y in interior.coords] for interior in poly.interiors]
			for poly in polygons
		],
	}
