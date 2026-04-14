# Batch Clipping Optimization - Implementation Guide

**Goal**: Combine optimized clipping (Option 1) with batch processing (Option 4) for scalable, efficient geometry copying.

---

## Changes Required

### 1. Database Changes

#### A. Create Optimized Batch Function

```sql
-- New function: get_clipped_geometries_batch
-- Replaces: get_clipped_geometries_for_patch
CREATE OR REPLACE FUNCTION public.get_clipped_geometries_batch(
  p_label_id bigint,
  p_geometry_table text,
  p_bbox_minx double precision,
  p_bbox_miny double precision,
  p_bbox_maxx double precision,
  p_bbox_maxy double precision,
  p_buffer_m double precision DEFAULT 2.0,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
  geometry jsonb,
  total_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  bbox_geom GEOMETRY;
  bbox_box2d BOX2D;
  total_intersecting bigint;
BEGIN
  -- Create bbox geometry in EPSG:3857 with buffer
  bbox_geom := ST_MakeEnvelope(
    p_bbox_minx - p_buffer_m,
    p_bbox_miny - p_buffer_m,
    p_bbox_maxx + p_buffer_m,
    p_bbox_maxy + p_buffer_m,
    3857
  );

  -- Transform to EPSG:4326 for comparison
  bbox_geom := ST_Transform(bbox_geom, 4326);

  -- Create BOX2D for faster clipping
  bbox_box2d := bbox_geom::box2d;

  -- Get total count (only on first batch)
  IF p_offset = 0 THEN
    EXECUTE format(
      'SELECT COUNT(*) FROM %I
       WHERE label_id = $1
       AND ST_Intersects(geometry, $2)',
      p_geometry_table
    ) INTO total_intersecting USING p_label_id, bbox_geom;
  ELSE
    total_intersecting := 0; -- Don't recount on subsequent batches
  END IF;

  -- Process geometries with optimizations
  RETURN QUERY EXECUTE format(
    'SELECT
      ST_AsGeoJSON(
        CASE
          WHEN ST_GeometryType(clipped_geom) = ''ST_GeometryCollection''
          THEN ST_CollectionExtract(clipped_geom, 3)
          ELSE clipped_geom
        END
      )::jsonb as geometry,
      $5 as total_count
    FROM (
      SELECT
        -- Use ST_ClipByBox2D for rectangular patches (3x faster)
        ST_ClipByBox2D(
          -- Only validate if invalid (conditional)
          CASE
            WHEN ST_IsValid(geometry) THEN geometry
            ELSE ST_MakeValid(geometry)
          END,
          $4
        ) as clipped_geom
      FROM %I
      WHERE label_id = $1
      AND ST_Intersects(geometry, $2)
      ORDER BY id  -- Stable ordering for pagination
      LIMIT $6
      OFFSET $7
    ) sub
    WHERE NOT ST_IsEmpty(clipped_geom)
    AND ST_GeometryType(clipped_geom) IN (''ST_Polygon'', ''ST_MultiPolygon'', ''ST_GeometryCollection'')',
    p_geometry_table
  ) USING
    p_label_id,           -- $1
    bbox_geom,            -- $2
    bbox_geom,            -- $3 (for ST_Intersects in subquery)
    bbox_box2d,           -- $4 (for ST_ClipByBox2D)
    total_intersecting,   -- $5
    p_limit,              -- $6
    p_offset;             -- $7
END;
$function$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.get_clipped_geometries_batch TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_clipped_geometries_batch TO service_role;
```

**Key Optimizations:**

1. ✅ `ST_ClipByBox2D` instead of `ST_Intersection` (3x faster)
2. ✅ Conditional `ST_MakeValid` (only if invalid)
3. ✅ `ORDER BY id` for stable pagination
4. ✅ Returns `total_count` only on first batch
5. ✅ Configurable `LIMIT` and `OFFSET`

#### B. Add Composite Index

```sql
-- Add composite GIST index for better performance
-- This combines label_id filtering with spatial filtering
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_forest_cover_label_geom
ON v2_forest_cover_geometries
USING GIST (label_id, geometry);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_deadwood_label_geom
ON v2_deadwood_geometries
USING GIST (label_id, geometry);
```

**Note**: `CONCURRENTLY` means it won't lock the table during creation.

---

### 2. Frontend Changes

#### A. Create Batch Processing Hook

**New file**: `src/hooks/useReferenceGeometriesBatch.ts`

```typescript
import { supabase } from "./useSupabase";
import { ILabelData } from "../types/labels";

interface BatchProgress {
  current: number;
  total: number;
  percentage: number;
  layer: "deadwood" | "forest_cover";
}

interface ClipGeometriesBatchParams {
  labelId: number;
  geometryTable: "v2_deadwood_geometries" | "v2_forest_cover_geometries";
  bbox: {
    minx: number;
    miny: number;
    maxx: number;
    maxy: number;
  };
  batchSize?: number;
  onProgress?: (progress: BatchProgress) => void;
}

interface BatchResult {
  geometry: unknown;
  total_count: number;
}

/**
 * Fetch and clip geometries in batches
 * Returns all clipped geometries as an array
 */
export async function clipGeometriesInBatches({
  labelId,
  geometryTable,
  bbox,
  batchSize = 50,
  onProgress,
}: ClipGeometriesBatchParams): Promise<unknown[]> {
  const allGeometries: unknown[] = [];
  let offset = 0;
  let totalCount: number | null = null;
  const layerType = geometryTable.includes("deadwood") ? "deadwood" : "forest_cover";

  console.log(`[Batch Clipping] Starting for ${layerType}, label ${labelId}`);

  while (true) {
    console.log(`[Batch Clipping] Fetching batch at offset ${offset}`);

    // Call the optimized batch RPC
    const { data, error } = await supabase.rpc("get_clipped_geometries_batch", {
      p_label_id: labelId,
      p_geometry_table: geometryTable,
      p_bbox_minx: bbox.minx,
      p_bbox_miny: bbox.miny,
      p_bbox_maxx: bbox.maxx,
      p_bbox_maxy: bbox.maxy,
      p_buffer_m: 2.0,
      p_limit: batchSize,
      p_offset: offset,
    });

    if (error) {
      console.error(`[Batch Clipping] Error at offset ${offset}:`, error);
      throw error;
    }

    if (!data || data.length === 0) {
      console.log(`[Batch Clipping] No more data at offset ${offset}`);
      break;
    }

    // Extract total count from first batch
    if (totalCount === null && data.length > 0) {
      totalCount = (data[0] as BatchResult).total_count;
      console.log(`[Batch Clipping] Total intersecting geometries: ${totalCount}`);
    }

    // Extract geometries from batch results
    const batchGeometries = data.map((row: BatchResult) => row.geometry);
    allGeometries.push(...batchGeometries);

    // Update progress
    if (onProgress && totalCount) {
      const progress: BatchProgress = {
        current: Math.min(offset + batchSize, totalCount),
        total: totalCount,
        percentage: Math.min(100, Math.round(((offset + batchSize) / totalCount) * 100)),
        layer: layerType,
      };
      onProgress(progress);
    }

    // If we got fewer results than batch size, we're done
    if (data.length < batchSize) {
      console.log(`[Batch Clipping] Completed - got ${data.length} in final batch`);
      break;
    }

    offset += batchSize;
  }

  console.log(`[Batch Clipping] Complete - ${allGeometries.length} geometries clipped`);
  return allGeometries;
}
```

#### B. Modify ReferencePatchEditorView

**File**: `src/components/ReferencePatches/ReferencePatchEditorView.tsx`

Find the `autoCopyPredictionsAsReference` function (around line 658) and replace it:

```typescript
// Add state for batch progress at the top of the component
const [batchProgress, setBatchProgress] = useState<{
  layer: "deadwood" | "forest_cover" | null;
  current: number;
  total: number;
  percentage: number;
} | null>(null);

// Import the batch function
import { clipGeometriesInBatches } from "../../hooks/useReferenceGeometriesBatch";

// Replace autoCopyPredictionsAsReference function
const autoCopyPredictionsAsReference = useCallback(
  async (basePatch: IReferencePatch) => {
    try {
      console.log("[Auto-copy] Starting batch processing for patch:", basePatch.id);

      // Fetch model prediction labels for deadwood and forest_cover
      const { data: deadwoodLabel } = await supabase
        .from("v2_labels")
        .select("id")
        .eq("dataset_id", dataset.id)
        .eq("label_data", ILabelData.DEADWOOD)
        .eq("label_source", "model_prediction")
        .maybeSingle();

      const { data: forestCoverLabel } = await supabase
        .from("v2_labels")
        .select("id")
        .eq("dataset_id", dataset.id)
        .eq("label_data", ILabelData.FOREST_COVER)
        .eq("label_source", "model_prediction")
        .maybeSingle();

      const bbox = {
        minx: basePatch.bbox_minx,
        miny: basePatch.bbox_miny,
        maxx: basePatch.bbox_maxx,
        maxy: basePatch.bbox_maxy,
      };

      // Process deadwood geometries in batches
      if (deadwoodLabel) {
        console.log("[Auto-copy] Processing deadwood geometries");

        const deadwoodGeoms = await clipGeometriesInBatches({
          labelId: deadwoodLabel.id,
          geometryTable: "v2_deadwood_geometries",
          bbox,
          batchSize: 50,
          onProgress: (progress) => {
            setBatchProgress({
              layer: "deadwood",
              current: progress.current,
              total: progress.total,
              percentage: progress.percentage,
            });
          },
        });

        if (deadwoodGeoms.length > 0) {
          console.log(`[Auto-copy] Saving ${deadwoodGeoms.length} deadwood geometries`);
          await saveGeometries({
            patchId: basePatch.id,
            datasetId: dataset.id,
            layerType: ILabelData.DEADWOOD,
            geometries: deadwoodGeoms,
          });
        } else {
          console.log("[Auto-copy] No deadwood geometries found in patch area");
        }
      }

      // Process forest cover geometries in batches
      if (forestCoverLabel) {
        console.log("[Auto-copy] Processing forest cover geometries");

        const forestCoverGeoms = await clipGeometriesInBatches({
          labelId: forestCoverLabel.id,
          geometryTable: "v2_forest_cover_geometries",
          bbox,
          batchSize: 50,
          onProgress: (progress) => {
            setBatchProgress({
              layer: "forest_cover",
              current: progress.current,
              total: progress.total,
              percentage: progress.percentage,
            });
          },
        });

        if (forestCoverGeoms.length > 0) {
          console.log(`[Auto-copy] Saving ${forestCoverGeoms.length} forest cover geometries`);
          await saveGeometries({
            patchId: basePatch.id,
            datasetId: dataset.id,
            layerType: ILabelData.FOREST_COVER,
            geometries: forestCoverGeoms,
          });
        } else {
          console.log("[Auto-copy] No forest cover geometries found in patch area");
        }
      }

      // Clear progress state
      setBatchProgress(null);
      console.log("[Auto-copy] Reference data auto-copied successfully");
    } catch (error) {
      // Clear progress on error
      setBatchProgress(null);
      console.error("[Auto-copy] Failed to auto-copy predictions:", error);
      throw error; // Re-throw to be caught by handleGenerateSubPatches
    }
  },
  [dataset.id, saveGeometries],
);
```

#### C. Add Progress Indicator Component

**File**: `src/components/ReferencePatches/BatchProgressIndicator.tsx`

```typescript
import { Progress, Typography } from "antd";

interface BatchProgressProps {
  layer: "deadwood" | "forest_cover";
  current: number;
  total: number;
  percentage: number;
}

export default function BatchProgressIndicator({ layer, current, total, percentage }: BatchProgressProps) {
  const layerLabel = layer === "deadwood" ? "Deadwood" : "Forest Cover";

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
      <Typography.Text strong className="mb-2 block">
        Copying {layerLabel} Geometries
      </Typography.Text>
      <Progress
        percent={percentage}
        status="active"
        strokeColor={{
          "0%": "#108ee9",
          "100%": "#87d068",
        }}
      />
      <Typography.Text type="secondary" className="mt-2 block text-sm">
        {current} / {total} geometries processed
      </Typography.Text>
    </div>
  );
}
```

#### D. Integrate Progress Indicator in UI

**File**: `src/components/ReferencePatches/ReferencePatchEditorView.tsx`

Add the progress indicator in the render (around line 850):

```typescript
import BatchProgressIndicator from "./BatchProgressIndicator";

// Inside the return statement, before the main map component:
return (
  <div className="flex h-full w-full flex-col">
    {/* Existing completion banner */}
    {isCompleted && (
      <Alert
        // ... existing props
      />
    )}

    {/* NEW: Batch Progress Indicator */}
    {batchProgress && (
      <div className="mx-4 mt-4">
        <BatchProgressIndicator
          layer={batchProgress.layer!}
          current={batchProgress.current}
          total={batchProgress.total}
          percentage={batchProgress.percentage}
        />
      </div>
    )}

    {/* Rest of existing UI */}
    <div className="flex min-h-0 flex-1">
      {/* ... map and sidebar */}
    </div>
  </div>
);
```

#### E. Update Loading Message

**File**: `src/components/ReferencePatches/ReferencePatchEditorView.tsx`

In `handleGenerateSubPatches` (around line 761), update the loading message:

```typescript
const handleGenerateSubPatches = useCallback(
  async (basePatch: IReferencePatch, currentGeometry?: GeoJSON.Polygon) => {
    try {
      // OLD: message.loading({ content: "Generating nested patches...", key: "generate" });
      // NEW:
      message.loading({ content: "Copying model predictions in batches...", key: "generate" });

      // ... rest of the function stays the same
    } catch (error) {
      console.error(error);
      message.error({ content: "Failed to generate patches", key: "generate" });
    }
  },
  [
    // ... dependencies
  ],
);
```

---

### 3. Migration Script (Optional but Recommended)

**File**: `docs/sql/optimize_geometry_tables.sql`

```sql
-- Run this to optimize existing data (optional, can be done later)

-- 1. Add composite indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_forest_cover_label_geom
ON v2_forest_cover_geometries
USING GIST (label_id, geometry);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_deadwood_label_geom
ON v2_deadwood_geometries
USING GIST (label_id, geometry);

-- 2. Validate and simplify existing geometries (run in batches)
-- This is OPTIONAL but will improve performance further
-- WARNING: This modifies data - test on a copy first!

DO $$
DECLARE
  batch_size INTEGER := 100;
  processed INTEGER := 0;
  total_invalid INTEGER;
BEGIN
  -- Get count of invalid geometries
  SELECT COUNT(*) INTO total_invalid
  FROM v2_forest_cover_geometries
  WHERE NOT ST_IsValid(geometry);

  RAISE NOTICE 'Found % invalid forest cover geometries', total_invalid;

  -- Fix invalid geometries in batches
  WHILE processed < total_invalid LOOP
    UPDATE v2_forest_cover_geometries
    SET geometry = ST_MakeValid(geometry)
    WHERE id IN (
      SELECT id
      FROM v2_forest_cover_geometries
      WHERE NOT ST_IsValid(geometry)
      LIMIT batch_size
    );

    processed := processed + batch_size;
    RAISE NOTICE 'Processed % / % geometries', processed, total_invalid;

    -- Give other queries a chance to run
    PERFORM pg_sleep(0.1);
  END LOOP;

  RAISE NOTICE 'Validation complete!';
END $$;

-- Repeat for deadwood if needed
DO $$
DECLARE
  batch_size INTEGER := 100;
  processed INTEGER := 0;
  total_invalid INTEGER;
BEGIN
  SELECT COUNT(*) INTO total_invalid
  FROM v2_deadwood_geometries
  WHERE NOT ST_IsValid(geometry);

  RAISE NOTICE 'Found % invalid deadwood geometries', total_invalid;

  WHILE processed < total_invalid LOOP
    UPDATE v2_deadwood_geometries
    SET geometry = ST_MakeValid(geometry)
    WHERE id IN (
      SELECT id
      FROM v2_deadwood_geometries
      WHERE NOT ST_IsValid(geometry)
      LIMIT batch_size
    );

    processed := processed + batch_size;
    RAISE NOTICE 'Processed % / % geometries', processed, total_invalid;
    PERFORM pg_sleep(0.1);
  END LOOP;

  RAISE NOTICE 'Validation complete!';
END $$;
```

---

## Implementation Steps

### Step 1: Database (5 minutes)

1. ✅ Run the SQL to create `get_clipped_geometries_batch` function
2. ✅ Run the SQL to create composite indexes
3. ✅ Test the function manually with dataset 6142

### Step 2: Frontend Hook (10 minutes)

1. ✅ Create `src/hooks/useReferenceGeometriesBatch.ts`
2. ✅ Export the function in `src/hooks/index.ts` (if you have one)

### Step 3: Progress UI (10 minutes)

1. ✅ Create `src/components/ReferencePatches/BatchProgressIndicator.tsx`
2. ✅ Add progress state to `ReferencePatchEditorView`
3. ✅ Integrate progress indicator in UI

### Step 4: Replace Old Function (15 minutes)

1. ✅ Replace `autoCopyPredictionsAsReference` in `ReferencePatchEditorView`
2. ✅ Update loading message in `handleGenerateSubPatches`
3. ✅ Remove old RPC call imports if no longer used

### Step 5: Testing (15 minutes)

1. ✅ Test with dataset 6142 (5,241 geometries)
2. ✅ Verify progress indicator updates
3. ✅ Check console logs for batch processing
4. ✅ Verify geometries are saved correctly
5. ✅ Test error handling (disconnect during batch)

### Step 6: Cleanup (optional)

1. ✅ Remove old `get_clipped_geometries_for_patch` function (or keep as fallback)
2. ✅ Run migration script to optimize existing data
3. ✅ Monitor `pg_stat_statements` for performance

---

## Expected Results

### Performance Comparison

| Metric                         | Before               | After (Optimized + Batched) |
| ------------------------------ | -------------------- | --------------------------- |
| **Dataset 6142 (5,241 geoms)** | Timeout (60s+)       | **~15-25 seconds** ✅       |
| **Batch size**                 | All at once          | 50 geometries per batch     |
| **Memory usage**               | High (all in memory) | Low (streaming)             |
| **User feedback**              | None (freezes)       | Real-time progress bar      |
| **Error recovery**             | Complete failure     | Partial success possible    |
| **Database load**              | Single huge query    | Distributed load            |

### User Experience

**Before:**

```
[Loading spinner for 60+ seconds]
❌ Error: Statement timeout
```

**After:**

```
Copying Model Predictions...
━━━━━━━━━━━━━━━━━━━━━━ 60%
Deadwood: 200 / 332 geometries processed

[3 seconds later]
━━━━━━━━━━━━━━━━━━━━━━ 45%
Forest Cover: 2,358 / 5,241 geometries processed

✅ Success! Reference data created
```

---

## Error Handling

### Partial Failures

If a batch fails midway:

- ✅ Already processed geometries are saved
- ✅ User sees which layer failed
- ✅ Can retry without losing progress

### Network Interruptions

- ✅ Each batch is independent
- ✅ Progress state shows last successful batch
- ✅ Can continue from last offset (with manual retry)

---

## Monitoring Queries

```sql
-- Check function performance
SELECT
  query,
  calls,
  mean_exec_time,
  max_exec_time
FROM pg_stat_statements
WHERE query LIKE '%get_clipped_geometries_batch%'
ORDER BY mean_exec_time DESC;

-- Check index usage
SELECT
  schemaname,
  tablename,
  indexname,
  idx_scan,
  idx_tup_read,
  idx_tup_fetch
FROM pg_stat_user_indexes
WHERE tablename IN ('v2_forest_cover_geometries', 'v2_deadwood_geometries')
ORDER BY idx_scan DESC;

-- Check if new index is being used
EXPLAIN ANALYZE
SELECT * FROM get_clipped_geometries_batch(
  10291,
  'v2_forest_cover_geometries',
  1444264, 6811479, 1444597, 6811812,
  2.0, 50, 0
);
```

---

## Rollback Plan

If something goes wrong:

```sql
-- Drop the new function
DROP FUNCTION IF EXISTS public.get_clipped_geometries_batch;

-- Revert to old function (if you kept it)
-- No changes needed - old code still works

-- Drop indexes if causing issues
DROP INDEX CONCURRENTLY IF EXISTS idx_forest_cover_label_geom;
DROP INDEX CONCURRENTLY IF EXISTS idx_deadwood_label_geom;
```

Frontend rollback:

```bash
git checkout HEAD -- src/hooks/useReferenceGeometriesBatch.ts
git checkout HEAD -- src/components/ReferencePatches/BatchProgressIndicator.tsx
git checkout HEAD -- src/components/ReferencePatches/ReferencePatchEditorView.tsx
```

---

## Future Enhancements

1. **Retry Failed Batches**: Add retry button for failed batches
2. **Parallel Processing**: Process deadwood and forest cover simultaneously
3. **Caching**: Cache clipped geometries per patch
4. **Compression**: Compress geometries before storing
5. **Background Processing**: Move to backend job queue for huge datasets

---

## Questions?

- **Batch size too small?** Increase to 100 for faster processing
- **Batch size too large?** Decrease to 25 for smoother progress
- **Want to cancel mid-batch?** Add abort controller to `clipGeometriesInBatches`
- **Need to resume after error?** Store last offset in state and restart from there
