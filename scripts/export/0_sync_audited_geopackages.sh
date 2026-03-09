#!/bin/bash

# =============================================================================
# Simple Batch Extract Audited Deadwood Labels
# =============================================================================
# Extracts all labels from datasets with final_assessment='no_issues'
# Creates GeoPackages with aoi, deadwood, and forest_cover layers
# Only processes datasets that don't already have geopackages
# =============================================================================

# Database Connection (from environment)
DB_HOST="${DEADTREES_DB_HOST:-}"
DB_PORT="${DEADTREES_DB_PORT:-}"
DB_NAME="${DEADTREES_DB_NAME:-}"
DB_USER="${DEADTREES_DB_USER:-}"
DB_PASSWORD="${DEADTREES_DB_PASSWORD:-}"

# Configuration
OUTPUT_DIR="/net/data_ssd/tree_mortality_orthophotos/deadtreesintegrated/audited_geopackages_export"

# =============================================================================

# Check prerequisites
if [ -z "$DB_HOST" ] || [ -z "$DB_PORT" ] || [ -z "$DB_NAME" ] || [ -z "$DB_USER" ] || [ -z "$DB_PASSWORD" ]; then
    echo "ERROR: Missing DB env vars. Required: DEADTREES_DB_HOST, DEADTREES_DB_PORT, DEADTREES_DB_NAME, DEADTREES_DB_USER, DEADTREES_DB_PASSWORD"
    exit 1
fi

if ! command -v ogr2ogr &> /dev/null; then
    echo "ERROR: ogr2ogr not found. Please install GDAL/OGR"
    exit 1
fi

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Database connection string
DB_CONN="PG:host=$DB_HOST port=$DB_PORT dbname=$DB_NAME user=$DB_USER password=$DB_PASSWORD"

# Returns the latest polygon/AOI change timestamp (epoch seconds) for a dataset.
# Falls back to 0 if nothing is found or the query fails.
get_latest_change_epoch() {
    local dataset_id="$1"
    local ts_csv
    local ts_epoch

    ts_csv=$(mktemp).csv

    ogr2ogr -f "CSV" \
        -sql "SELECT COALESCE(CAST(EXTRACT(EPOCH FROM GREATEST(
                COALESCE((SELECT MAX(COALESCE(dg.updated_at, dg.created_at))
                          FROM v2_deadwood_geometries dg
                          JOIN v2_labels l ON dg.label_id = l.id
                          WHERE l.dataset_id = ${dataset_id}), TIMESTAMP '1970-01-01'),
                COALESCE((SELECT MAX(COALESCE(fg.updated_at, fg.created_at))
                          FROM v2_forest_cover_geometries fg
                          JOIN v2_labels l ON fg.label_id = l.id
                          WHERE l.dataset_id = ${dataset_id}), TIMESTAMP '1970-01-01'),
                COALESCE((SELECT MAX(COALESCE(a.updated_at, a.created_at))
                          FROM v2_aois a
                          WHERE a.dataset_id = ${dataset_id}), TIMESTAMP '1970-01-01')
                ,
                COALESCE((SELECT MAX(COALESCE(c.reviewed_at, c.created_at))
                          FROM v2_geometry_corrections c
                          WHERE c.dataset_id = ${dataset_id}), TIMESTAMP '1970-01-01')
              )) AS BIGINT), 0) AS latest_change_epoch" \
        "$ts_csv" \
        "$DB_CONN" >/dev/null 2>&1

    if [ $? -ne 0 ] || [ ! -f "$ts_csv" ]; then
        rm -f "$ts_csv"
        echo 0
        return
    fi

    ts_epoch=$(tail -n +2 "$ts_csv" | head -n 1 | tr -d '\r')
    rm -f "$ts_csv"

    if [[ "$ts_epoch" =~ ^[0-9]+$ ]]; then
        echo "$ts_epoch"
    else
        echo 0
    fi
}

echo "=========================================="
echo "Extracting Audited Deadwood Labels"
echo "=========================================="

# Get all high-quality audited datasets
echo "Finding high-quality audited datasets..."
TEMP_CSV=$(mktemp).csv

# AND da.has_valid_acquisition_date = true
# AND da.has_valid_phenology = true
# AND da.is_georeferenced = true

ogr2ogr -f "CSV" \
    -sql "SELECT DISTINCT
            da.dataset_id,
            d.file_name as dataset_name
          FROM dataset_audit da
          JOIN v2_datasets d ON da.dataset_id = d.id
          WHERE da.final_assessment = 'no_issues'
          AND da.deadwood_quality != 'bad'
          AND da.forest_cover_quality != 'bad'
          ORDER BY da.dataset_id" \
    "$TEMP_CSV" \
    "$DB_CONN"

if [ $? -ne 0 ] || [ ! -f "$TEMP_CSV" ]; then
    echo "ERROR: Failed to connect to database or no audited datasets found"
    rm -f "$TEMP_CSV"
    exit 1
fi

# Skip header line
tail -n +2 "$TEMP_CSV" > "${TEMP_CSV}.data"
mv "${TEMP_CSV}.data" "$TEMP_CSV"

TOTAL_DATASETS=$(wc -l < "$TEMP_CSV")
echo "Found $TOTAL_DATASETS high-quality audited datasets"

if [ "$TOTAL_DATASETS" -eq 0 ]; then
    echo "No high-quality audited datasets found"
    rm -f "$TEMP_CSV"
    exit 0
fi

# Process each dataset
PROCESSED=0
CREATED=0
SKIPPED=0

while IFS=',' read -r dataset_id dataset_name; do
    output_file="$OUTPUT_DIR/dataset_${dataset_id}.gpkg"

    # Skip only if file already exists and DB has no newer polygon/AOI changes
    if [ -f "$output_file" ]; then
        local_mtime=$(stat -c %Y "$output_file" 2>/dev/null)
        latest_change_epoch=$(get_latest_change_epoch "$dataset_id")

        if [ -n "$local_mtime" ] && [ "$latest_change_epoch" -le "$local_mtime" ]; then
            echo "[$((++PROCESSED))/$TOTAL_DATASETS] SKIP: $(basename "$output_file") (up-to-date)"
            ((SKIPPED++))
            continue
        fi

        echo "[$((++PROCESSED))/$TOTAL_DATASETS] REFRESH: Dataset $dataset_id (DB has newer changes)"
        rm -f "$output_file"
    fi

    echo "[$((++PROCESSED))/$TOTAL_DATASETS] PROCESSING: Dataset $dataset_id"

    # Extract AOI layer (creates the file)
    ogr2ogr -f "GPKG" \
        -nln "aoi" \
        -sql "SELECT
                a.id,
                a.dataset_id,
                ST_GeomFromGeoJSON(a.geometry::text) as geometry,
                a.is_whole_image,
                a.image_quality,
                a.notes,
                a.created_at
              FROM v2_aois a
              WHERE a.dataset_id = $dataset_id" \
        "$output_file" \
        "$DB_CONN" 2>/dev/null

    # Extract deadwood layer from canonical candidate view.
    # Polygon-selection logic is already resolved in the view.
    # Export script only applies use-case level dataset audit filters.
    ogr2ogr -f "GPKG" \
        -update \
        -nln "deadwood_auto_cover" \
        -sql "SELECT
                id,
                label_id,
                dataset_id,
                geometry,
                area_m2,
                properties,
                created_at,
                updated_at,
                recommended_export_mode as export_mode,
                has_pending_model_edits
              FROM v_export_polygon_candidates
              WHERE dataset_id = $dataset_id
                AND layer_type = 'deadwood'
                AND final_assessment = 'no_issues'
                AND deadwood_quality != 'bad'
                AND forest_cover_quality != 'bad'" \
        "$output_file" \
        "$DB_CONN" 2>/dev/null

    # Extract forest cover layer from canonical candidate view with same approach.
    ogr2ogr -f "GPKG" \
        -update \
        -nln "forest_auto_cover" \
        -sql "SELECT
                id,
                label_id,
                dataset_id,
                geometry,
                area_m2,
                properties,
                created_at,
                updated_at,
                recommended_export_mode as export_mode,
                has_pending_model_edits
              FROM v_export_polygon_candidates
              WHERE dataset_id = $dataset_id
                AND layer_type = 'forest_cover'
                AND final_assessment = 'no_issues'
                AND deadwood_quality != 'bad'
                AND forest_cover_quality != 'bad'" \
        "$output_file" \
        "$DB_CONN" 2>/dev/null

    if [ -f "$output_file" ]; then
        file_size=$(du -h "$output_file" | cut -f1)
        echo "    CREATED: $(basename "$output_file") ($file_size)"
        ((CREATED++))
    else
        echo "    ERROR: Failed to create geopackage"
        rm -f "$output_file"
    fi

done < "$TEMP_CSV"

# Cleanup
rm -f "$TEMP_CSV"

echo "=========================================="
echo "Summary:"
echo "  Total datasets: $TOTAL_DATASETS"
echo "  Created: $CREATED"
echo "  Skipped: $SKIPPED"
echo "  Output directory: $OUTPUT_DIR"
echo "=========================================="

if [ "$CREATED" -gt 0 ]; then
    echo "SUCCESS: $CREATED new geopackages created"
else
    echo "INFO: No new geopackages created (all already exist)"
fi
