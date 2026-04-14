# 5cm-Only QA Workflow Implementation Plan

**Date:** 2025-01-15  
**Status:** ✅ Complete  
**Implemented:** 2025-01-15

---

## Overview

Update the reference patch editor to only QA 5cm patches directly, while automatically deriving 10cm patch status from their children. This simplifies the workflow and reduces QA time.

## Design Decisions

1. **Starting workflow**: Go directly to 5cm patches after generating sub-patches
2. **10cm patch visibility**: Visible on map for spatial context, but not QA-able
3. **Status propagation**: Auto-update 10cm status when all 4 children are marked
4. **Navigation**: Only show 5cm patches in sidebar/tabs (no 10cm tab)
5. **Progress display**: Only show 5cm patch counts
6. **Database**: Keep current structure, auto-calculate 10cm status

## Implementation Steps

### 1. Add Status Propagation Logic

**File**: `src/hooks/useReferencePatches.ts`

- Add function to calculate parent status from children
- Add mutation to update parent patch status
- Hook into `useUpdatePatchStatus` to trigger propagation

**Logic**:

```typescript
// When a 5cm patch status changes:
// 1. Find parent 10cm patch
// 2. Get all 4 sibling 5cm patches
// 3. If all 4 are "good" → parent is "good"
// 4. If any is "bad" → parent is "bad"
// 5. Otherwise → parent is "pending"
```

### 2. Update Editor View After Generation

**File**: `src/components/ReferencePatches/ReferencePatchEditorView.tsx`

- Line ~790: Change `setSelectedResolution(10)` to `setSelectedResolution(5)`
- Update auto-select logic to select first 5cm patch (not 10cm)

### 3. Update Sidebar Tabs

**File**: `src/components/ReferencePatches/PatchDetailSidebar.tsx`

- Line ~442-466: Remove 10cm from tabs, only show 5cm
- Keep 20cm tab only when base patch is pending (for generation)
- Update navigation logic to skip 10cm resolution

### 4. Update Progress Calculation

**File**: `src/pages/DatasetReferencePatchEditor.tsx`

- Line ~39-49: Update progress to only count 5cm patches
- Remove 10cm counts from display
- Line ~224-241: Update progress summary UI

**File**: `src/hooks/useReferencePatches.ts`

- Line ~338-372: Update `usePatchProgress` to focus on 5cm patches
- Keep 10cm counts for backward compatibility but mark as auto-validated

### 5. Update Phase Manager (if used)

**File**: `src/components/ReferencePatches/PatchPhaseManager.tsx`

- Update progress display to focus on 5cm patches
- Update completion logic

### 6. Update QA Phase (if used)

**File**: `src/components/ReferencePatches/qa/PatchQAPhase.tsx`

- Line ~19: Remove 10cm from `QA_RESOLUTIONS`
- Change to only show 5cm patches for QA

### 7. Update Validation Phase (if used)

**File**: `src/components/ReferencePatches/validation/PatchValidationPhase.tsx`

- Keep as-is (allows filtering all resolutions for review)

## Backward Compatibility

- ✅ Existing datasets with 10cm patches already marked: Continue to work
- ✅ Database schema: No changes needed
- ✅ Export scripts: No changes needed (they use bbox data)
- ✅ Map visualization: 10cm patches still visible for context

## Testing Checklist

- [x] Generate new base patch → creates 4×10cm + 16×5cm patches
- [x] Auto-switches to 5cm resolution after generation
- [x] Marking 5cm patches updates parent 10cm status
- [x] All 4 children "good" → parent "good"
- [x] Any child "bad" → parent "bad"
- [x] Progress only shows 5cm counts
- [x] Sidebar tabs only show 5cm (and 20cm when pending)
- [x] Keyboard shortcuts work on 5cm patches only
- [ ] **Manual Testing Required**: Existing datasets with marked 10cm patches still work

## Files Changed

1. `src/hooks/useReferencePatches.ts` - Add status propagation
2. `src/components/ReferencePatches/ReferencePatchEditorView.tsx` - Start with 5cm
3. `src/components/ReferencePatches/PatchDetailSidebar.tsx` - Remove 10cm tab
4. `src/pages/DatasetReferencePatchEditor.tsx` - Update progress display
5. `src/components/ReferencePatches/qa/PatchQAPhase.tsx` - Remove 10cm QA (if used)
6. `src/components/ReferencePatches/PatchPhaseManager.tsx` - Update progress (if used)

---

**Estimated Impact**: Medium - changes workflow but maintains backward compatibility
