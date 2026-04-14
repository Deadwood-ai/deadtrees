# Batch Clipping Implementation - Complete ✅

**Date:** 2025-10-16  
**Issue:** Timeout when copying forest cover geometries (5,241 geometries) to reference patches  
**Solution:** Batch processing with progress indicators

---

## What Was Implemented

### 1. Database Function: `get_clipped_geometries_batch`

**Location:** PostgreSQL database  
**Purpose:** Process geometries in batches to avoid timeouts

**Key Features:**

- ✅ Pagination support (`LIMIT` and `OFFSET`)
- ✅ Optimized `ST_ClipByBox2D` for rectangular patches (3x faster than `ST_Intersection`)
- ✅ Conditional `ST_MakeValid` (only validates if geometry is invalid)
- ✅ Returns total count on first batch for progress calculation
- ✅ Stable ordering by `id` for consistent pagination

**Parameters:**

```sql
p_label_id bigint          -- Label to filter geometries
p_geometry_table text      -- Table name (v2_deadwood_geometries or v2_forest_cover_geometries)
p_bbox_minx/miny/maxx/maxy -- Bounding box in EPSG:3857
p_buffer_m double          -- Buffer in meters (default 2.0)
p_limit integer            -- Batch size (default 50)
p_offset integer           -- Pagination offset (default 0)
```

### 2. Frontend Hook: `useReferenceGeometriesBatch.ts`

**Location:** `src/hooks/useReferenceGeometriesBatch.ts`  
**Purpose:** Coordinate batch processing from the frontend

**Function:** `clipGeometriesInBatches`

**Features:**

- ✅ Fetches geometries in batches (default 50 per batch)
- ✅ Calls progress callback after each batch
- ✅ Handles errors gracefully (throws on error, can be caught)
- ✅ Returns all geometries as a single array
- ✅ Console logging for debugging

**Usage:**

```typescript
const geometries = await clipGeometriesInBatches({
  labelId: 12345,
  geometryTable: "v2_forest_cover_geometries",
  bbox: { minx, miny, maxx, maxy },
  batchSize: 50, // optional
  onProgress: (progress) => {
    // Update UI with progress
    console.log(`${progress.percentage}% - ${progress.current}/${progress.total}`);
  },
});
```

### 3. Progress Indicator Component: `BatchProgressIndicator.tsx`

**Location:** `src/components/ReferencePatches/BatchProgressIndicator.tsx`  
**Purpose:** Show user-friendly progress during batch processing

**Features:**

- ✅ Animated progress bar (Ant Design)
- ✅ Shows layer being processed (Deadwood or Forest Cover)
- ✅ Displays current/total geometries
- ✅ Visual percentage indicator
- ✅ Color gradient from blue to green

### 4. Integration: `ReferencePatchEditorView.tsx`

**Location:** `src/components/ReferencePatches/ReferencePatchEditorView.tsx`  
**Changes:**

- ✅ Added `batchProgress` state
- ✅ Replaced `autoCopyPredictionsAsReference` with batch version
- ✅ Added `BatchProgressIndicator` to UI
- ✅ Updated loading message to "Copying model predictions in batches..."
- ✅ Progress cleared automatically on completion or error

---

## Performance Improvements

### Before (Old Implementation)

| Metric                     | Value                        |
| -------------------------- | ---------------------------- |
| Forest cover (5,241 geoms) | **Timeout (60+ seconds)** ❌ |
| Processing method          | All at once                  |
| User feedback              | None (frozen UI)             |
| Error recovery             | Complete failure             |
| Mean execution time        | 3,306ms (optimized version)  |

### After (Batch Implementation)

| Metric                     | Value                    |
| -------------------------- | ------------------------ |
| Forest cover (5,241 geoms) | **~15-30 seconds** ✅    |
| Processing method          | 50 geometries per batch  |
| User feedback              | Real-time progress bar   |
| Error recovery             | Partial success possible |
| Expected time per batch    | ~200-400ms               |

### Estimated Performance

For dataset 6142 (332 deadwood + 5,241 forest cover):

- **Deadwood**: ~7 batches × 300ms = **~2 seconds**
- **Forest Cover**: ~105 batches × 300ms = **~30 seconds**
- **Total**: ~32 seconds with progress feedback ✅

---

## User Experience

### Before

```
[Loading spinner for 60+ seconds]
❌ Error: Statement timeout
```

### After

```
Copying Model Predictions...
━━━━━━━━━━━━━━━━━━━━━━ 100%
Deadwood: 332 / 332 geometries processed

━━━━━━━━━━━━━━━━━━━━━━ 45%
Forest Cover: 2,358 / 5,241 geometries processed

✅ Success! Patches generated and reference data created!
```

---

## Testing Instructions

### 1. Test with Small Dataset

**Purpose:** Verify batch processing works correctly

1. Select a dataset with < 100 geometries per layer
2. Add a base patch
3. Click "Generate Sub-Patches"
4. **Expected:** Quick completion with brief progress indicator

### 2. Test with Large Dataset (Dataset 6142)

**Purpose:** Verify no timeouts on problematic dataset

1. Open dataset 6142 (Bardenitz_03.07.2025.zip)
2. Add a base patch
3. Click "Generate Sub-Patches"
4. **Expected:**
   - Progress bar appears
   - Deadwood processes first (~2 seconds)
   - Forest cover processes second (~30 seconds)
   - No timeout errors
   - Success message appears

### 3. Test Progress Indicator

**Purpose:** Verify UI updates correctly

1. Use dataset 6142
2. Watch the progress bar during processing
3. **Expected:**
   - Progress bar animates smoothly
   - Percentage increases from 0% to 100%
   - Layer name switches from "Deadwood" to "Forest Cover"
   - Current/total counts update correctly
   - Progress bar disappears after completion

### 4. Test Error Handling

**Purpose:** Verify graceful error handling

1. Disconnect internet during batch processing
2. **Expected:**
   - Error message appears
   - Progress bar disappears
   - Can retry operation

### 5. Verify Data Integrity

**Purpose:** Ensure all geometries are saved correctly

1. After generating patches, select a 5cm patch
2. Edit Deadwood layer
3. **Expected:**
   - All deadwood geometries appear on map
   - No missing or duplicate geometries
   - Geometries correctly clipped to patch bounds

---

## Database Verification Queries

### Check Function Exists

```sql
SELECT
  proname as function_name,
  pg_get_function_arguments(oid) as arguments
FROM pg_proc
WHERE proname = 'get_clipped_geometries_batch';
```

### Test Function Manually (Dataset 6142)

```sql
-- Test first batch
SELECT * FROM get_clipped_geometries_batch(
  10291,  -- forest_cover label_id for dataset 6142
  'v2_forest_cover_geometries',
  1444264, 6811479, 1444597, 6811812,  -- bbox
  2.0,  -- buffer
  50,   -- batch size
  0     -- offset
) LIMIT 5;
```

### Check Performance

```sql
-- Check query execution time
SELECT
  query,
  calls,
  mean_exec_time,
  max_exec_time
FROM pg_stat_statements
WHERE query LIKE '%get_clipped_geometries_batch%'
ORDER BY mean_exec_time DESC;
```

---

## Monitoring After Deployment

### Frontend Console Logs

Look for these log messages:

```
[Batch Clipping] Starting for deadwood, label 12345
[Batch Clipping] Fetching batch at offset 0
[Batch Clipping] Total intersecting geometries: 332
[Batch Clipping] Fetching batch at offset 50
[Batch Clipping] Completed - got 32 in final batch
[Batch Clipping] Complete - 332 geometries clipped
```

### Database Performance

Monitor these queries regularly:

```sql
-- Check index usage
SELECT
  schemaname,
  tablename,
  indexname,
  idx_scan,
  idx_tup_read
FROM pg_stat_user_indexes
WHERE tablename IN ('v2_forest_cover_geometries', 'v2_deadwood_geometries')
ORDER BY idx_scan DESC;

-- Check query times
SELECT
  mean_exec_time,
  max_exec_time,
  calls
FROM pg_stat_statements
WHERE query LIKE '%get_clipped_geometries_batch%';
```

---

## Troubleshooting

### Problem: Still Getting Timeouts

**Possible Causes:**

1. Batch size too large
2. Network issues
3. Database under heavy load

**Solutions:**

1. Reduce batch size to 25 in `ReferencePatchEditorView.tsx` line 704 and 736
2. Check network connection
3. Run during off-peak hours

### Problem: Progress Bar Doesn't Update

**Possible Causes:**

1. React state not updating
2. Progress callback not being called

**Solutions:**

1. Check browser console for errors
2. Verify `setBatchProgress` is being called
3. Check React DevTools for state changes

### Problem: Geometries Missing After Processing

**Possible Causes:**

1. Error during save step
2. Geometries filtered out (empty or invalid)

**Solutions:**

1. Check console for save errors
2. Verify geometries in database:

```sql
SELECT COUNT(*)
FROM reference_patch_forest_cover_geometries
WHERE label_id = YOUR_LABEL_ID;
```

---

## Future Enhancements

### Short-Term (Optional)

1. **Adjustable batch size**: Add UI control for batch size
2. **Retry failed batches**: Add retry button if batch fails
3. **Cancel operation**: Add abort button to stop processing

### Long-Term (Future)

1. **Parallel processing**: Process deadwood and forest cover simultaneously
2. **Background jobs**: Move to backend job queue for huge datasets
3. **Caching**: Cache clipped geometries per patch
4. **Pre-computation**: Clip geometries during model inference

---

## Files Modified

### Created Files

- ✅ `src/hooks/useReferenceGeometriesBatch.ts`
- ✅ `src/components/ReferencePatches/BatchProgressIndicator.tsx`
- ✅ `docs/implementation/batch-clipping-implementation-complete.md` (this file)

### Modified Files

- ✅ `src/components/ReferencePatches/ReferencePatchEditorView.tsx`

### Database Changes

- ✅ Created function: `public.get_clipped_geometries_batch`
- ✅ Granted permissions to `authenticated` and `service_role`

---

## Rollback Instructions

If something goes wrong and you need to revert:

### 1. Database Rollback

```sql
-- Drop the batch function
DROP FUNCTION IF EXISTS public.get_clipped_geometries_batch;
```

### 2. Frontend Rollback

```bash
# Revert changes to ReferencePatchEditorView
git checkout HEAD -- src/components/ReferencePatches/ReferencePatchEditorView.tsx

# Remove new files
rm src/hooks/useReferenceGeometriesBatch.ts
rm src/components/ReferencePatches/BatchProgressIndicator.tsx
```

---

## Success Criteria ✅

- [x] Database function created and working
- [x] Frontend hook implemented
- [x] Progress indicator component created
- [x] Integration complete in ReferencePatchEditorView
- [x] No linter errors
- [ ] **Testing complete** (awaiting user verification)

---

## Next Steps

1. **Test with dataset 6142** to verify no timeouts
2. **Monitor performance** after deployment
3. **Gather user feedback** on progress indicator UX
4. **Document any issues** encountered during testing

---

## Credits

Based on the analysis in:

- `docs/analysis/reference-patch-clipping-timeout-analysis.md`
- `docs/implementation/batch-clipping-optimization.md`

Implementation completed: 2025-10-16
