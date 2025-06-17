# Comprehensive Testing for GeoTIFF Processing Pipeline

This directory contains comprehensive tests for the full GeoTIFF processing pipeline.

## Test Structure

### Regular Tests
- `test_process_cog_success()` - Tests individual COG processing
- Other individual processor tests

### Comprehensive Tests (Marked as `slow` and `comprehensive`)
- `test_comprehensive_all_small_files_pipeline()` - Tests all files in `assets/test_data/debugging/testcases/small/`
- Tests the full pipeline: GeoTIFF → COG → Thumbnail → Metadata

## Running Tests

### Default (excludes slow/comprehensive tests)
```bash
pytest processor/tests/
```

### Run comprehensive tests
```bash
# Run all comprehensive tests
pytest -m comprehensive

# Run specific comprehensive test
pytest -m "slow and comprehensive" processor/tests/test_process_cog.py::test_comprehensive_all_small_files_pipeline

# Run all tests including slow ones
pytest -m ""
```

## Creating Test Data

### Using the cropping script
```bash
# 1. Create original folder and add your GeoTIFF files
mkdir original
cp /path/to/your/geotiffs/*.tif original/

# 2. Run the cropping script to create small test files
python scripts/create_small_test_data.py

# 3. Run comprehensive tests
pytest -m comprehensive
```

### Manual setup
You can also manually place small GeoTIFF files in:
```
assets/test_data/debugging/testcases/small/
```

## Test Results

The comprehensive test will:
1. Process each file through the full pipeline (geotiff, cog, thumbnail, metadata)
2. Verify database entries are created correctly
3. Show detailed results for each file
4. Pass if ≥50% of files process successfully

Example output:
```
=== Testing 7 small test files ===

--- Processing small_prima2.tif ---
✅ Successfully processed small_prima2.tif

--- Processing small_3885_ortho_black.tif ---
❌ Failed to process small_3885_ortho_black.tif: Error message...

=== FINAL RESULTS ===
✅ Successful: 5/7 files
❌ Failed: 2/7 files

✅ Comprehensive test passed with 71.4% success rate
```

## What Gets Tested

For each file, the test verifies:

### Database Tables
- `orthos_processed` - GeoTIFF standardization results
- `cogs` - COG creation results  
- `thumbnails` - Thumbnail generation results
- `metadata` - Metadata extraction results
- `statuses` - Processing status tracking

### Status Checks
- `is_ortho_done: true`
- `is_cog_done: true`
- `is_thumbnail_done: true`
- `is_metadata_done: true`
- `has_error: false`
- `current_status: idle`

### File Properties
- File sizes > 0
- Processing runtimes > 0
- Required metadata fields present (gadm, biome)
- COG validation info present 