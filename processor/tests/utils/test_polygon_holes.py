import pytest
from shapely.geometry import Polygon
import json
from processor.src.deadwood_segmentation.deadtreesmodels.common.common import reproject_polygons


def test_polygon_with_holes_conversion():
	"""Test conversion of polygons with holes to GeoJSON format"""
	# Create a test polygon with a hole
	exterior = [(0, 0), (0, 10), (10, 10), (10, 0), (0, 0)]
	interior = [(2, 2), (2, 8), (8, 8), (8, 2), (2, 2)]
	poly = Polygon(exterior, [interior])

	# Create a list to mimic the output from deadwood inference
	polygons = [poly]

	# Convert to GeoJSON format with proper handling of holes
	geojson = {
		'type': 'MultiPolygon',
		'coordinates': [
			[[[float(x), float(y)] for x, y in polygon.exterior.coords]]
			+ [[[float(x), float(y)] for x, y in interior.coords] for interior in polygon.interiors]
			for polygon in polygons
		],
	}

	# Validate that the GeoJSON structure is correct
	assert geojson['type'] == 'MultiPolygon'
	assert len(geojson['coordinates']) == 1  # One polygon
	assert len(geojson['coordinates'][0]) == 2  # Exterior + 1 hole

	# Validate the coordinates - both exterior and interior should be present
	exterior_coords = geojson['coordinates'][0][0]
	interior_coords = geojson['coordinates'][0][1]

	assert len(exterior_coords) == 5  # 5 points in exterior (including closure)
	assert len(interior_coords) == 5  # 5 points in interior (including closure)

	# Verify that the interior ring is included
	assert [2.0, 2.0] in interior_coords
	assert [8.0, 8.0] in interior_coords


def test_multiple_polygons_with_holes():
	"""Test conversion of multiple polygons with holes to GeoJSON format"""
	# Create two test polygons, each with a hole
	poly1 = Polygon([(0, 0), (0, 10), (10, 10), (10, 0), (0, 0)], [[(2, 2), (2, 8), (8, 8), (8, 2), (2, 2)]])

	poly2 = Polygon(
		[(20, 20), (20, 30), (30, 30), (30, 20), (20, 20)], [[(22, 22), (22, 28), (28, 28), (28, 22), (22, 22)]]
	)

	# Create a list with both polygons
	polygons = [poly1, poly2]

	# Convert to GeoJSON format with proper handling of holes
	geojson = {
		'type': 'MultiPolygon',
		'coordinates': [
			[[[float(x), float(y)] for x, y in polygon.exterior.coords]]
			+ [[[float(x), float(y)] for x, y in interior.coords] for interior in polygon.interiors]
			for polygon in polygons
		],
	}

	# Validate that the GeoJSON structure is correct
	assert geojson['type'] == 'MultiPolygon'
	assert len(geojson['coordinates']) == 2  # Two polygons

	# Each polygon should have an exterior and one interior ring
	assert len(geojson['coordinates'][0]) == 2
	assert len(geojson['coordinates'][1]) == 2

	# Validate first polygon coordinates
	exterior1 = geojson['coordinates'][0][0]
	interior1 = geojson['coordinates'][0][1]
	assert [0.0, 0.0] in exterior1
	assert [2.0, 2.0] in interior1

	# Validate second polygon coordinates
	exterior2 = geojson['coordinates'][1][0]
	interior2 = geojson['coordinates'][1][1]
	assert [20.0, 20.0] in exterior2
	assert [22.0, 22.0] in interior2


def test_polygon_with_multiple_holes():
	"""Test conversion of a polygon with multiple holes to GeoJSON format"""
	# Create a test polygon with two holes
	exterior = [(0, 0), (0, 30), (30, 30), (30, 0), (0, 0)]
	interior1 = [(5, 5), (5, 10), (10, 10), (10, 5), (5, 5)]
	interior2 = [(15, 15), (15, 25), (25, 25), (25, 15), (15, 15)]

	poly = Polygon(exterior, [interior1, interior2])
	polygons = [poly]

	# Convert to GeoJSON format with proper handling of holes
	geojson = {
		'type': 'MultiPolygon',
		'coordinates': [
			[[[float(x), float(y)] for x, y in polygon.exterior.coords]]
			+ [[[float(x), float(y)] for x, y in interior.coords] for interior in polygon.interiors]
			for polygon in polygons
		],
	}

	# Validate that the GeoJSON structure is correct
	assert geojson['type'] == 'MultiPolygon'
	assert len(geojson['coordinates']) == 1  # One polygon
	assert len(geojson['coordinates'][0]) == 3  # Exterior + 2 holes

	# Verify the interior rings
	interior1_coords = geojson['coordinates'][0][1]
	interior2_coords = geojson['coordinates'][0][2]

	assert [5.0, 5.0] in interior1_coords
	assert [15.0, 15.0] in interior2_coords
