#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="$ROOT_DIR/test/fixtures/geotiff/upload-validation"
ARCHIVE_DIR="/home/jj1049/mount_storage_server/archive"

mkdir -p "$FIXTURE_DIR"

gdal_translate -srcwin 0 0 64 64 "$ARCHIVE_DIR/1000_ortho.tif" "$FIXTURE_DIR/rgb-real-crop.tif"
gdal_translate -srcwin 0 0 64 64 "$ARCHIVE_DIR/8781_ortho.tif" "$FIXTURE_DIR/rgba-real-crop.tif"
gdal_translate -srcwin 0 0 64 64 "$ARCHIVE_DIR/8770_ortho.tif" "$FIXTURE_DIR/red-alpha-real-crop.tif"
gdal_translate -srcwin 0 0 64 64 "$ARCHIVE_DIR/8772_ortho.tif" "$FIXTURE_DIR/nir-alpha-real-crop.tif"

echo "Upload-validation fixtures regenerated in $FIXTURE_DIR"
