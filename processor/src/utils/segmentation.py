import json

import geopandas as gpd
import numpy as np
import rasterio
import rasterio.enums
import rasterio.warp
import shapely
from rasterio.vrt import WarpedVRT
from shapely.affinity import affine_transform
from shapely.geometry import Polygon

from .crs import get_utm_string_from_latlon
from .nodata import has_alpha_band, resolve_nodata_policy


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


def mask_to_polygons_scanline(dataset, class_value):
	"""Polygonize pixels matching class_value without loading the full raster.

	Uses rasterio.features.shapes with a Band reference so GDAL reads
	scanline-by-scanline rather than materialising the full array. The band is
	also its own mask, so the background (0) is never traced: in a dense forest
	mask its holes are as many polygons as the trees. Returns polygons in the
	dataset CRS.
	"""
	from rasterio.features import shapes

	if class_value == 0:
		raise ValueError('class 0 is the background and is never polygonized')
	band = rasterio.Band(dataset, 1, dataset.dtypes[0], dataset.shape)
	return _polygons_from_rings(
		geom['coordinates'] for geom, val in shapes(band, mask=band, transform=dataset.transform) if int(val) == class_value
	)


def _polygons_from_rings(polygon_rings) -> list[Polygon]:
	"""Polygons from GeoJSON-style ring lists (shell first), built in one vectorized call."""
	coords, ring_lengths, rings_per_polygon = [], [], []
	for rings in polygon_rings:
		rings_per_polygon.append(len(rings))
		for ring in rings:
			ring_lengths.append(len(ring))
			coords.extend(ring)
	if not rings_per_polygon:
		return []
	linear_rings = shapely.linearrings(
		np.asarray(coords, dtype=np.float64), indices=np.repeat(np.arange(len(ring_lengths)), ring_lengths)
	)
	return list(shapely.polygons(linear_rings, indices=np.repeat(np.arange(len(rings_per_polygon)), rings_per_polygon)))


def mask_to_polygons_in_blocks(dataset, class_value, block_size, padding):
	"""Polygonize pixels matching class_value one block at a time.

	Yields ``(core_bounds, polygons)`` per ``block_size`` pixel block. The polygons
	cover the block plus ``padding`` pixels on each side, so a caller can simplify
	them and clip to ``core_bounds`` (minx, miny, maxx, maxy in the dataset CRS)
	without block-edge artefacts. Neighbouring cores share their edges exactly.
	"""
	from rasterio.features import shapes
	from rasterio.windows import Window
	from rasterio.windows import bounds as window_bounds
	from shapely.geometry import shape as shapely_shape

	for row in range(0, dataset.height, block_size):
		for col in range(0, dataset.width, block_size):
			core = Window(col, row, min(block_size, dataset.width - col), min(block_size, dataset.height - row))
			row_off, col_off = max(row - padding, 0), max(col - padding, 0)
			padded = Window(
				col_off,
				row_off,
				min(col + core.width + padding, dataset.width) - col_off,
				min(row + core.height + padding, dataset.height) - row_off,
			)
			block = dataset.read(1, window=padded)
			matches = block == class_value
			if not matches.any():
				continue
			geometries = shapes(block, mask=matches, transform=dataset.window_transform(padded))
			yield window_bounds(core, dataset.transform), [shapely_shape(geom) for geom, _ in geometries]


def mask_to_polygons(mask, dataset_reader):
	"""Convert a binary mask into polygons in the dataset CRS."""
	import cv2
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

	# Transparency travels as an alpha band: the source's own, or one GDAL adds
	# from the source mask, nodata value and the warp border. A forced nodata
	# value would also hide every valid pixel whose first band equals it, such as
	# the darkest shadows of a stretched ortho (DT-1374).
	vrt = WarpedVRT(
		dataset,
		crs=utm_crs,
		transform=default_transform,
		width=width,
		height=height,
		dtype='uint8',
		add_alpha=not has_alpha_band(dataset),
	)
	# Resolve nodata handling once from the source and stash it on the VRT so
	# every consumer gets a correct mask via read_nodata_mask() — see nodata.py.
	vrt.nodata_policy = resolve_nodata_policy(dataset)
	return vrt


def image_band_indexes(vrt) -> list[int]:
	"""Up to three image bands of an image_reprojector VRT, leaving out its alpha band."""
	return [i for i, ci in enumerate(vrt.colorinterp, start=1) if ci != rasterio.enums.ColorInterp.alpha][:3]


def reproject_polygons(polygons, src_crs, dst_crs):
	"""Reproject polygons from src_crs to dst_crs."""
	reprojected = rasterio.warp.transform_geom(src_crs, dst_crs, polygons)
	if isinstance(reprojected, list):
		return shapely.from_geojson([json.dumps(item) for item in reprojected])
	return shapely.from_geojson(json.dumps(reprojected))


def filter_polygons_by_area(polygons, min_area):
	"""Filter polygons and interior rings below the minimum area."""
	polygons = np.asarray(polygons, dtype=object)
	rings, owner = shapely.get_rings(polygons, return_index=True)
	filtered = []
	if len(rings):
		# Every polygon's shell comes first; its holes are kept when they are large enough.
		shell = np.r_[True, owner[1:] != owner[:-1]]
		keep = shell | (shapely.area(shapely.polygons(rings)) >= min_area)
		_, kept_owner = np.unique(owner[keep], return_inverse=True)
		rebuilt = shapely.polygons(rings[keep], indices=kept_owner)
		filtered = list(rebuilt[shapely.area(rebuilt) >= min_area])

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
