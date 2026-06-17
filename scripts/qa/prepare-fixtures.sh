#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DATA_ROOT="${DEADTREES_QA_DATA_ROOT:-${LOCAL_DATA_ROOT:-$REPO_ROOT/.local/qa-data}}"

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

write_fixture_file() {
	local path="$1"
	local label="$2"
	if [[ ! -f "$path" ]]; then
		printf 'DeadTrees local QA fixture: %s\n' "$label" > "$path"
	fi
}

write_fixture_file "$DATA_ROOT/archive/qa-public-complete.tif" "archive dataset 91001"
write_fixture_file "$DATA_ROOT/archive/qa-public-audited.tif" "archive dataset 91002"
write_fixture_file "$DATA_ROOT/archive/qa-private-contributor.tif" "archive dataset 91003"
write_fixture_file "$DATA_ROOT/archive/qa-processing-error.tif" "archive dataset 91004"
write_fixture_file "$DATA_ROOT/cogs/qa/cogs/qa-public-complete-cog.tif" "COG dataset 91001"
write_fixture_file "$DATA_ROOT/cogs/qa/cogs/qa-public-audited-cog.tif" "COG dataset 91002"
write_fixture_file "$DATA_ROOT/thumbnails/qa/thumbnails/qa-public-complete.png" "thumbnail dataset 91001"
write_fixture_file "$DATA_ROOT/thumbnails/qa/thumbnails/qa-public-audited.png" "thumbnail dataset 91002"

echo "Prepared local QA fixture files under $DATA_ROOT"
