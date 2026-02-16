"""
Download small COG clips from the remote DTE maps for local development/testing.

Usage (from project root, inside venv with rasterio or inside API container):
	python scripts/download_dte_test_clips.py

This downloads ~3km x 3km clips around the Harz area for forest + deadwood COGs.
The clips are saved to data/assets/dte_maps/ with the same naming convention as production.
"""

import os
import sys
from pathlib import Path

import rasterio
from rasterio.windows import from_bounds
from pyproj import Transformer


# COG base URL and naming
BASE_URL = "https://data2.deadtrees.earth/assets/v1/dte_maps/"
FILE_PATTERN = "run_v1004_v1000_crop_half_fold_None_checkpoint_199_{type}_{year}.cog.tif"

# Years and types
ALL_YEARS = ["2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024", "2025"]
DEFAULT_YEARS = ["2020", "2022", "2025"]  # Subset for faster download
TYPES = ["deadwood", "forest"]

# Test area: Harz mountains, Germany (~3km x 3km)
BBOX_WGS84 = {
	"west": 10.640,
	"south": 51.770,
	"east": 10.700,
	"north": 51.800,
}


def transform_bbox_to_3857(bbox: dict) -> dict:
	"""Transform a WGS84 bbox to EPSG:3857."""
	transformer = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
	west, south = transformer.transform(bbox["west"], bbox["south"])
	east, north = transformer.transform(bbox["east"], bbox["north"])
	return {"west": west, "south": south, "east": east, "north": north}


def download_clip(url: str, output_path: Path, bbox_3857: dict) -> bool:
	"""Download a COG clip from a remote URL using windowed reads."""
	print(f"  Downloading from {url}...")

	try:
		with rasterio.open(url) as src:
			window = from_bounds(
				bbox_3857["west"], bbox_3857["south"],
				bbox_3857["east"], bbox_3857["north"],
				src.transform
			)
			window = window.round_offsets().round_lengths()

			data = src.read(window=window)
			transform = src.window_transform(window)

			profile = src.profile.copy()
			profile.update(
				driver="GTiff",
				height=window.height,
				width=window.width,
				transform=transform,
				tiled=True,
				blockxsize=256,
				blockysize=256,
				compress="deflate",
			)

			with rasterio.open(output_path, "w", **profile) as dst:
				dst.write(data)

			size_kb = output_path.stat().st_size / 1024
			print(f"  Saved {output_path.name} ({size_kb:.0f} KB, {window.width}x{window.height} px)")
			return True

	except Exception as e:
		print(f"  ERROR: {e}")
		return False


def main():
	years = ALL_YEARS if "--all-years" in sys.argv else DEFAULT_YEARS

	output_dir = Path(__file__).parent.parent / "data" / "assets" / "dte_maps"
	output_dir.mkdir(parents=True, exist_ok=True)

	print(f"Downloading DTE map test clips to {output_dir}")
	print(f"Years: {', '.join(years)}")
	print(f"Test area: Harz ({BBOX_WGS84['west']:.3f}, {BBOX_WGS84['south']:.3f}) to ({BBOX_WGS84['east']:.3f}, {BBOX_WGS84['north']:.3f})")
	print()

	bbox_3857 = transform_bbox_to_3857(BBOX_WGS84)
	print(f"EPSG:3857 bbox: ({bbox_3857['west']:.0f}, {bbox_3857['south']:.0f}) to ({bbox_3857['east']:.0f}, {bbox_3857['north']:.0f})")
	print()

	os.environ["GDAL_HTTP_MERGE_CONSECUTIVE_RANGES"] = "YES"
	os.environ["GDAL_DISABLE_READDIR_ON_OPEN"] = "EMPTY_DIR"
	os.environ["CPL_VSIL_CURL_ALLOWED_EXTENSIONS"] = ".tif"

	success_count = 0
	total_count = len(years) * len(TYPES)

	for year in years:
		for cog_type in TYPES:
			filename = FILE_PATTERN.format(type=cog_type, year=year)
			url = BASE_URL + filename
			output_path = output_dir / filename

			if output_path.exists():
				print(f"  SKIP {filename} (already exists)")
				success_count += 1
				continue

			if download_clip(url, output_path, bbox_3857):
				success_count += 1

	print(f"\nDone: {success_count}/{total_count} clips downloaded successfully.")
	print(f"Clips saved to: {output_dir}")


if __name__ == "__main__":
	main()
