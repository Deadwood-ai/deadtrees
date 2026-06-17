#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DATA_ROOT="${DEADTREES_QA_DATA_ROOT:-${LOCAL_DATA_ROOT:-$REPO_ROOT/.local/qa-data}}"
SOURCE_GEOTIFF="$REPO_ROOT/frontend/test/fixtures/geotiff/upload-validation/rgb-real-crop.tif"
SOURCE_THUMBNAIL="$REPO_ROOT/frontend/public/assets/custom_marker.png"

usage() {
	cat >&2 <<'USAGE'
Usage: scripts/qa/prepare-fixtures.sh [qa-base|qa-full]

Creates deterministic local-only QA files under ignored data/ directories.
USAGE
}

PROFILE="${1:-qa-full}"
case "$PROFILE" in
	qa-base|qa-full)
		;;
	-h|--help)
		usage
		exit 0
		;;
	*)
		echo "Unknown QA fixture profile: $PROFILE" >&2
		usage
		exit 1
		;;
esac

mkdir -p \
	"$DATA_ROOT/archive" \
	"$DATA_ROOT/cogs/qa/cogs" \
	"$DATA_ROOT/thumbnails/qa/thumbnails" \
	"$DATA_ROOT/downloads" \
	"$DATA_ROOT/raw_images" \
	"$DATA_ROOT/label_objects"

require_source_file() {
	local path="$1"
	if [[ ! -f "$path" ]]; then
		echo "Missing QA fixture source file: $path" >&2
		exit 1
	fi
}

copy_fixture_file() {
	local source="$1"
	local target="$2"
	require_source_file "$source"
	cp "$source" "$target"
}

write_cog_fixture() {
	local source="$1"
	local target="$2"
	require_source_file "$source"
	if ! command -v gdal_translate >/dev/null 2>&1; then
		echo "gdal_translate is required to generate QA COG fixtures." >&2
		exit 1
	fi
	gdal_translate -q -of COG "$source" "$target"
}

copy_fixture_file "$SOURCE_GEOTIFF" "$DATA_ROOT/archive/qa-public-complete.tif"
copy_fixture_file "$SOURCE_GEOTIFF" "$DATA_ROOT/archive/qa-public-audited.tif"
copy_fixture_file "$SOURCE_GEOTIFF" "$DATA_ROOT/archive/qa-private-contributor.tif"
copy_fixture_file "$SOURCE_GEOTIFF" "$DATA_ROOT/archive/qa-processing-error.tif"
write_cog_fixture "$SOURCE_GEOTIFF" "$DATA_ROOT/cogs/qa/cogs/qa-public-complete-cog.tif"
write_cog_fixture "$SOURCE_GEOTIFF" "$DATA_ROOT/cogs/qa/cogs/qa-public-audited-cog.tif"
copy_fixture_file "$SOURCE_THUMBNAIL" "$DATA_ROOT/thumbnails/qa/thumbnails/qa-public-complete.png"
copy_fixture_file "$SOURCE_THUMBNAIL" "$DATA_ROOT/thumbnails/qa/thumbnails/qa-public-audited.png"

echo "Prepared local QA fixture files under $DATA_ROOT"
