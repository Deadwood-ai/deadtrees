# Layer-Specific Validation Implementation

**Date**: January 17, 2025  
**Status**: ✅ Complete

## Overview

Updated the reference patch editor to track deadwood and forest cover validation separately, enabling users to validate all deadwood patches first, then all forest cover patches (or vice versa).

## Database Schema

The database now includes two new boolean fields in `reference_patches`:

- `deadwood_validated`: `null` = pending, `true` = good, `false` = bad
- `forest_cover_validated`: `null` = pending, `true` = good, `false` = bad

The legacy `status` field is deprecated but maintained for backwards compatibility.

## Changes Made

### 1. TypeScript Types (`src/types/referencePatches.ts`)

Added new validation fields to `IReferencePatch`:

```typescript
// Layer-specific validation (null = pending, true = good, false = bad)
deadwood_validated: boolean | null;
forest_cover_validated: boolean | null;
```

Updated `IPatchGenerationProgress` to track layer-specific progress:

```typescript
// New layer-specific validation tracking
deadwood_validated_5cm: number;
deadwood_good_5cm: number;
deadwood_bad_5cm: number;
deadwood_pending_5cm: number;
forest_cover_validated_5cm: number;
forest_cover_good_5cm: number;
forest_cover_bad_5cm: number;
forest_cover_pending_5cm: number;
```

### 2. Hooks (`src/hooks/useReferencePatches.ts`)

**Added new hook**: `useUpdatePatchLayerValidation()`

- Updates validation for a specific layer (deadwood OR forest_cover)
- Parameters: `{ patchId, layer: "deadwood" | "forest_cover", validated: boolean | null }`

**Updated**: `usePatchProgress()`

- Now fetches and calculates layer-specific validation statistics
- Counts validated patches per layer separately

**Updated**: `useGenerateNestedPatches()`

- Initializes new patches with `deadwood_validated: null` and `forest_cover_validated: null`
- Includes `utm_zone` and `epsg_code` in child patches

### 3. Sidebar Component (`src/components/ReferencePatches/PatchDetailSidebar.tsx`)

**New Props**:

- `onLayerValidation`: Callback for layer-specific validation

**Two Progress Bars**:

- Displays separate progress bars for deadwood and forest cover
- Active layer's bar is visually emphasized with thicker stroke and different color
- Deadwood uses blue (#1890ff), Forest Cover uses green (#52c41a)

**Updated Validation Logic**:

- `displayStatus`: Shows validation state based on the currently active layer
- `handleRadioStatusChange`: Validates only the active layer
- `handleClearRating`: Clears validation for the active layer
- `findNextPendingPatch`: Finds next patch pending for the current layer

### 4. Editor View (`src/components/ReferencePatches/ReferencePatchEditorView.tsx`)

**Added**:

- Import and use `useUpdatePatchLayerValidation` hook
- Pass `onLayerValidation` callback to `PatchDetailSidebar`

**Updated**:

- All `createPatch` calls now include `deadwood_validated: null` and `forest_cover_validated: null`

## User Workflow

### Validation Workflow

1. User selects a layer (Deadwood or Forest Cover) using keyboard shortcuts (2 or 3) or radio buttons
2. User validates patches with Q (good) or R (bad) - this validates only the active layer
3. System auto-advances to the next patch pending for the current layer
4. User can switch layers at any time to validate the other layer

### Example: Batch by Layer

1. Select "Deadwood" layer (press 2)
2. Validate all deadwood patches (Q/R for each)
3. Switch to "Forest Cover" layer (press 3)
4. Validate all forest cover patches (Q/R for each)

### Example: Batch by Patch

1. Select first patch, validate deadwood (press 2, then Q/R)
2. Switch to forest cover (press 3), validate (Q/R)
3. Move to next patch automatically
4. Repeat for all patches

## Visual Design

**Progress Bars**:

- Two vertically stacked progress bars in the sidebar
- Active layer's bar has:
  - Thicker stroke (12px vs 8px)
  - Custom color (blue for deadwood, green for forest cover)
  - Bold font weight on labels
- Shows count format: "X / Y" where X = validated, Y = total

## Database Changes

**BREAKING CHANGE**: The `status` column has been **removed** from the `reference_patches` table in the database.

### Migration Impact

- The `status` field (`"pending" | "good" | "bad"`) no longer exists in the database
- All patch validation is now tracked via `deadwood_validated` and `forest_cover_validated`
- The TypeScript type `PatchStatus` is kept for UI display logic only

### Code Changes Required

- Removed all database queries selecting the `status` column
- Removed `status` field from patch creation (`createPatch` calls)
- Updated all logic to use validation fields instead of status
- `useUpdatePatchStatus()` hook is deprecated (still exists for backwards compatibility)

## Database Indexes

The database includes a new index for efficient validation queries:

```sql
CREATE INDEX idx_ref_patches_validation
ON reference_patches (dataset_id, deadwood_validated, forest_cover_validated);
```

## Testing Recommendations

1. ✅ Create new patches - verify they have null validation fields
2. ✅ Validate deadwood layer - verify only deadwood_validated is updated
3. ✅ Validate forest cover layer - verify only forest_cover_validated is updated
4. ✅ Switch layers - verify progress bars update correctly
5. ✅ Auto-advance - verify it finds next pending patch for active layer
6. ✅ Clear rating - verify it clears only the active layer's validation
7. ✅ Progress tracking - verify both progress bars update independently

## Files Modified

- `src/types/referencePatches.ts`
- `src/hooks/useReferencePatches.ts`
- `src/components/ReferencePatches/PatchDetailSidebar.tsx`
- `src/components/ReferencePatches/ReferencePatchEditorView.tsx`

## Next Steps

Consider deprecating the legacy `status` field entirely once all existing patches have been migrated to the new validation system.
