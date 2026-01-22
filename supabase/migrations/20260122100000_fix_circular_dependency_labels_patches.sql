-- Migration: Fix circular dependency between v2_labels and reference_patches
-- 
-- Problem: 
--   v2_labels.reference_patch_id → reference_patches.id
--   reference_patches.reference_deadwood_label_id → v2_labels.id
--   reference_patches.reference_forest_cover_label_id → v2_labels.id
--
-- This creates a circular FK dependency that blocks pg_dump/restore and 
-- makes migrations complex (chicken-and-egg problem).
--
-- Solution: Drop only the FK CONSTRAINTS, keep the columns as denormalized data.
-- This breaks the circular dependency while preserving existing code functionality.
-- 
-- The columns become "soft references" (application-level, not DB-enforced).
-- Future refactoring can remove the columns entirely if desired.

BEGIN;

-- Drop the foreign key constraints (breaks the circular dependency)
ALTER TABLE reference_patches 
    DROP CONSTRAINT IF EXISTS fk_patches_ref_deadwood_label;

ALTER TABLE reference_patches 
    DROP CONSTRAINT IF EXISTS fk_patches_ref_forest_cover_label;

-- Add comments explaining the change
COMMENT ON COLUMN reference_patches.reference_deadwood_label_id IS 
    'Soft reference to v2_labels.id (FK removed to break circular dependency). Application must ensure consistency.';

COMMENT ON COLUMN reference_patches.reference_forest_cover_label_id IS 
    'Soft reference to v2_labels.id (FK removed to break circular dependency). Application must ensure consistency.';

COMMIT;
