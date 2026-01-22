-- Migration: Clean up empty legacy tables (v1_*, dev_*, and other unused tables)
--
-- These tables are all empty (0 rows) and are migration debt from earlier versions.
-- They have FK constraints so must be dropped in correct order.
--
-- Verified empty on 2026-01-22:
--   v1_* tables: 8 tables, 0 rows each
--   dev_* tables: 9 tables, 0 rows each  
--   Other: upload_files_dev, labels_dev_egu, metadata_dev_egu, metadata_dev_egu_v2, logs
--
-- Drop order respects FK dependencies:
--   1. Views first (depend on tables)
--   2. Child tables (have FK to parent)
--   3. Parent tables (referenced by children)
--   4. Independent tables (no FK dependencies)

BEGIN;

-- ============================================================
-- PHASE 1: Drop views that depend on legacy tables
-- ============================================================

DROP VIEW IF EXISTS dev_full_dataset_view CASCADE;
DROP VIEW IF EXISTS dev_queue_positions CASCADE;
DROP VIEW IF EXISTS v1_full_dataset_view CASCADE;
DROP VIEW IF EXISTS v1_dataset_logs CASCADE;
DROP VIEW IF EXISTS v1_queue_positions CASCADE;

-- ============================================================
-- PHASE 2: Drop dev_* tables (child tables first)
-- ============================================================

-- Children of dev_datasets
DROP TABLE IF EXISTS dev_cogs CASCADE;
DROP TABLE IF EXISTS dev_geotiff_info CASCADE;
DROP TABLE IF EXISTS dev_label_objects CASCADE;
DROP TABLE IF EXISTS dev_labels CASCADE;
DROP TABLE IF EXISTS dev_metadata CASCADE;
DROP TABLE IF EXISTS dev_queue CASCADE;
DROP TABLE IF EXISTS dev_thumbnails CASCADE;

-- dev_logs only references users (not dev_datasets)
DROP TABLE IF EXISTS dev_logs CASCADE;

-- Parent table (after all children dropped)
DROP TABLE IF EXISTS dev_datasets CASCADE;

-- ============================================================
-- PHASE 3: Drop v1_* tables (child tables first)
-- ============================================================

-- Children of v1_datasets
DROP TABLE IF EXISTS v1_cogs CASCADE;
DROP TABLE IF EXISTS v1_geotiff_info CASCADE;
DROP TABLE IF EXISTS v1_label_objects CASCADE;
DROP TABLE IF EXISTS v1_labels CASCADE;
DROP TABLE IF EXISTS v1_metadata CASCADE;
DROP TABLE IF EXISTS v1_queue CASCADE;

-- v1_thumbnails only references users (not v1_datasets)
DROP TABLE IF EXISTS v1_thumbnails CASCADE;

-- Parent table (after all children dropped)
DROP TABLE IF EXISTS v1_datasets CASCADE;

-- ============================================================
-- PHASE 4: Drop other orphaned/legacy tables
-- ============================================================

-- upload_files_dev - only FK to users, empty
DROP TABLE IF EXISTS upload_files_dev CASCADE;

-- Legacy EGU demo tables - no FK constraints, empty
DROP TABLE IF EXISTS labels_dev_egu CASCADE;
DROP TABLE IF EXISTS metadata_dev_egu CASCADE;
DROP TABLE IF EXISTS metadata_dev_egu_v2 CASCADE;

-- Old logs table (superseded by v2_logs) - empty
-- Note: v2_logs shares constraint name 'public_logs_user_id_fkey' 
-- so we need to be careful here
DROP TABLE IF EXISTS logs CASCADE;

COMMIT;
