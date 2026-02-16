"""Tests for the DTE stats polygon endpoint."""

import tempfile
from pathlib import Path

import pytest
import numpy as np
import rasterio
from rasterio.transform import from_bounds
from rasterio.crs import CRS
from fastapi.testclient import TestClient
from pyproj import Transformer

from api.src.server import app
from shared.settings import settings


client = TestClient(app)

MAX_AREA_KM2 = 1000.0

# ---------- Test constants ----------

# Test area: small box in the Harz region (inside the clip bbox)
TEST_POLYGON_WGS84 = {
	"type": "Polygon",
	"coordinates": [[[10.65, 51.78], [10.68, 51.78], [10.68, 51.79], [10.65, 51.79], [10.65, 51.78]]]
}

# Very large polygon (should exceed area limit)
LARGE_POLYGON_WGS84 = {
	"type": "Polygon",
	"coordinates": [[[0.0, 50.0], [1.0, 50.0], [1.0, 51.0], [0.0, 51.0], [0.0, 50.0]]]
}


# ---------- Synthetic COG helper ----------

def _create_synthetic_cog(path: Path, cog_type: str, year: int) -> Path:
	"""Create a small synthetic COG for testing."""
	filename = f"run_v1004_v1000_crop_half_fold_None_checkpoint_199_{cog_type}_{year}.cog.tif"
	filepath = path / filename

	transformer = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
	west, south = transformer.transform(10.60, 51.75)
	east, north = transformer.transform(10.72, 51.82)

	transform = from_bounds(west, south, east, north, 100, 100)

	np.random.seed(year * 10 + (1 if cog_type == "deadwood" else 2))
	data = np.random.randint(0, 200, size=(1, 100, 100), dtype=np.uint8)
	data[0, :5, :5] = 0  # some nodata

	profile = {
		"driver": "GTiff",
		"dtype": "uint8",
		"width": 100,
		"height": 100,
		"count": 1,
		"crs": CRS.from_epsg(3857),
		"transform": transform,
		"nodata": 0,
		"tiled": True,
		"blockxsize": 256,
		"blockysize": 256,
		"compress": "deflate",
	}

	with rasterio.open(str(filepath), "w", **profile) as dst:
		dst.write(data)

	return filepath


# ---------- Fixtures ----------

@pytest.fixture()
def synthetic_cog_dir():
	"""Create a temp dir with synthetic COGs and point settings at it."""
	with tempfile.TemporaryDirectory() as tmpdir:
		tmppath = Path(tmpdir)
		for year in [2020, 2022, 2025]:
			_create_synthetic_cog(tmppath, "deadwood", year)
			_create_synthetic_cog(tmppath, "forest", year)

		original = settings.DTE_MAPS_PATH
		settings.DTE_MAPS_PATH = str(tmppath)
		yield tmppath
		settings.DTE_MAPS_PATH = original


@pytest.fixture()
def empty_cog_dir():
	"""Point settings at an empty directory (no COGs)."""
	with tempfile.TemporaryDirectory() as tmpdir:
		original = settings.DTE_MAPS_PATH
		settings.DTE_MAPS_PATH = tmpdir
		yield Path(tmpdir)
		settings.DTE_MAPS_PATH = original


# ===================================================================
# Tests
# ===================================================================

def test_polygon_stats_with_synthetic_data(synthetic_cog_dir):
	"""Test the endpoint with synthetic COG data (threshold-based counting)."""
	response = client.post(
		"/dte-stats/polygon",
		json={"polygon": TEST_POLYGON_WGS84},
	)

	assert response.status_code == 200
	data = response.json()

	# Structure
	assert "polygon_area_km2" in data
	assert "cover_threshold_pct" in data
	assert "available_years" in data
	assert "stats" in data
	assert data["polygon_area_km2"] > 0
	assert data["polygon_area_km2"] < MAX_AREA_KM2
	assert data["cover_threshold_pct"] == 20.0
	assert len(data["available_years"]) == 3
	assert data["available_years"] == [2020, 2022, 2025]

	# Per-year stats (threshold-based: pixel counts and area)
	for stat in data["stats"]:
		assert "year" in stat
		assert stat["deadwood_pixel_count"] is not None
		assert stat["tree_cover_pixel_count"] is not None
		assert stat["deadwood_pixel_count"] >= 0
		assert stat["tree_cover_pixel_count"] >= 0
		assert stat["deadwood_area_ha"] >= 0
		assert stat["tree_cover_area_ha"] >= 0


def test_polygon_too_large():
	"""Test that a polygon exceeding 1000 km² is rejected."""
	response = client.post(
		"/dte-stats/polygon",
		json={"polygon": LARGE_POLYGON_WGS84},
	)

	assert response.status_code == 400
	assert "exceeds maximum" in response.json()["detail"]


def test_invalid_polygon_type():
	"""Test that non-Polygon geometries are rejected."""
	response = client.post(
		"/dte-stats/polygon",
		json={"polygon": {"type": "Point", "coordinates": [10.65, 51.78]}},
	)

	assert response.status_code == 400
	assert "must be a Polygon" in response.json()["detail"]


def test_polygon_too_few_vertices():
	"""Test that polygons with too few vertices are rejected."""
	response = client.post(
		"/dte-stats/polygon",
		json={"polygon": {"type": "Polygon", "coordinates": [[[10.65, 51.78], [10.68, 51.78]]]}},
	)

	assert response.status_code == 400


def test_no_cog_data(empty_cog_dir):
	"""Test response when no COGs are available."""
	response = client.post(
		"/dte-stats/polygon",
		json={"polygon": TEST_POLYGON_WGS84},
	)

	assert response.status_code == 404
	assert "No DTE map COGs found" in response.json()["detail"]


def test_mercator_area_correction(synthetic_cog_dir):
	"""
	Verify that the area calculation applies the cos²(lat) Mercator correction.

	At lat ~51.785° (Harz test polygon centroid), cos²(lat) ≈ 0.387,
	so the corrected pixel area should be ~38.7% of the raw Mercator pixel area.
	"""
	import math
	from api.src.routers.dte_stats import compute_pixel_area_ha, PIXEL_AREA_MERCATOR_M2

	centroid_lat = 51.785  # approximate centroid of TEST_POLYGON_WGS84
	corrected_ha = compute_pixel_area_ha(centroid_lat)
	mercator_ha = PIXEL_AREA_MERCATOR_M2 / 10_000

	# The corrected area must be significantly smaller than the Mercator area
	assert corrected_ha < mercator_ha * 0.5, (
		f"Corrected area {corrected_ha:.6f} ha should be < 50% of "
		f"Mercator area {mercator_ha:.6f} ha at lat {centroid_lat}°"
	)

	# Check against known cos² value
	expected_ratio = math.cos(math.radians(centroid_lat)) ** 2
	actual_ratio = corrected_ha / mercator_ha
	assert abs(actual_ratio - expected_ratio) < 0.001, (
		f"Ratio {actual_ratio:.4f} should match cos²({centroid_lat}°) = {expected_ratio:.4f}"
	)

	# Verify the endpoint returns area values using the corrected pixel area
	response = client.post(
		"/dte-stats/polygon",
		json={"polygon": TEST_POLYGON_WGS84},
	)
	assert response.status_code == 200
	data = response.json()

	# With threshold counting, area = pixel_count * corrected_ha
	# So area must be exactly pixel_count * corrected_ha (within rounding)
	for stat in data["stats"]:
		if stat["tree_cover_area_ha"] is not None and stat["tree_cover_pixel_count"]:
			expected_ha = stat["tree_cover_pixel_count"] * corrected_ha
			assert abs(stat["tree_cover_area_ha"] - expected_ha) < 0.01, (
				f"Tree cover area {stat['tree_cover_area_ha']} ha should equal "
				f"{expected_ha:.4f} ha ({stat['tree_cover_pixel_count']} pixels × {corrected_ha:.6f} ha)"
			)


def test_polygon_stats_with_real_data():
	"""
	Integration test using real COG clips already on disk.
	Run `python scripts/download_dte_test_clips.py` first to populate the data.
	Skipped if clips are not present.
	"""
	maps_dir = settings.dte_maps_path
	if not maps_dir.exists() or not any(maps_dir.glob("*.tif")):
		pytest.skip("No real COG test data — run: python scripts/download_dte_test_clips.py")

	response = client.post(
		"/dte-stats/polygon",
		json={"polygon": TEST_POLYGON_WGS84},
	)

	assert response.status_code == 200
	data = response.json()
	assert len(data["stats"]) > 0
	assert data["polygon_area_km2"] > 0

	for stat in data["stats"]:
		if stat["tree_cover_area_ha"] is not None:
			assert stat["tree_cover_area_ha"] >= 0
		if stat["deadwood_area_ha"] is not None:
			assert stat["deadwood_area_ha"] >= 0
