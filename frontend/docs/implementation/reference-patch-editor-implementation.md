# Reference Patch Editor - Implementation Documentation

**Last Updated:** January 17, 2025  
**Status:** ✅ Production Ready  
**Location:** `/datasets/:id/reference-patches`

---

## Overview

The Reference Patch Editor is a specialized tool for creating and validating high-resolution training data for ML models. It addresses two critical challenges:

1. **Georeferencing Accuracy**: Ensures reference patches have correct ground dimensions using geodesic calculations
2. **Layer-Specific Validation**: Enables independent validation of deadwood and forest cover predictions

---

## Architecture

### Data Model

Reference patches follow a hierarchical structure:

```
Base Patch (20cm resolution, ~205m × 205m ground distance)
├─ 4× 10cm Patches (102.4m × 102.4m ground distance)
│  ├─ 4× 5cm Patches (51.2m × 51.2m ground distance)
│  ├─ 4× 5cm Patches
│  ├─ 4× 5cm Patches
│  └─ 4× 5cm Patches
└─ Total: 16× 5cm patches per base patch
```

**Key Characteristics:**

- Only base patches (20cm) store reference geometry data
- Sub-patches (10cm, 5cm) inherit reference data from their parent
- Each patch has independent validation state per layer (deadwood, forest cover)

### Database Schema

```sql
-- reference_patches table
CREATE TABLE reference_patches (
  id BIGSERIAL PRIMARY KEY,
  dataset_id BIGINT NOT NULL,
  user_id TEXT NOT NULL,
  
  -- Spatial properties
  geometry JSONB NOT NULL,          -- GeoJSON Polygon in EPSG:3857
  bbox_minx DOUBLE PRECISION,
  bbox_miny DOUBLE PRECISION,
  bbox_maxx DOUBLE PRECISION,
  bbox_maxy DOUBLE PRECISION,
  
  -- UTM projection metadata (for correct georeferencing)
  utm_zone VARCHAR(10),             -- e.g., "32N", "17S"
  epsg_code INTEGER,                -- e.g., 32632 for UTM 32N
  
  -- Hierarchy
  resolution_cm INTEGER NOT NULL,   -- 20, 10, or 5
  parent_tile_id BIGINT REFERENCES reference_patches(id),
  patch_index TEXT NOT NULL,        -- e.g., "20_0_3_1"
  
  -- Reference geometry links (base patches only)
  reference_deadwood_label_id BIGINT REFERENCES v2_labels(id),
  reference_forest_cover_label_id BIGINT REFERENCES v2_labels(id),
  
  -- Layer-specific validation (null = pending, true = good, false = bad)
  deadwood_validated BOOLEAN,
  forest_cover_validated BOOLEAN,
  
  -- Coverage metadata
  aoi_coverage_percent DOUBLE PRECISION,
  deadwood_prediction_coverage_percent DOUBLE PRECISION,
  forest_cover_prediction_coverage_percent DOUBLE PRECISION,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Reference geometry storage (separate tables for protection)
CREATE TABLE reference_patch_deadwood_geometries (
  id BIGSERIAL PRIMARY KEY,
  label_id BIGINT NOT NULL REFERENCES v2_labels(id) ON DELETE CASCADE,
  patch_id BIGINT NOT NULL REFERENCES reference_patches(id) ON DELETE CASCADE,
  geometry JSONB NOT NULL,          -- GeoJSON geometry
  area_m2 DOUBLE PRECISION,
  properties JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE reference_patch_forest_cover_geometries (
  id BIGSERIAL PRIMARY KEY,
  label_id BIGINT NOT NULL REFERENCES v2_labels(id) ON DELETE CASCADE,
  patch_id BIGINT NOT NULL REFERENCES reference_patches(id) ON DELETE CASCADE,
  geometry JSONB NOT NULL,
  area_m2 DOUBLE PRECISION,
  properties JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Geodesic-Correct Patch Placement

### Problem: Web Mercator Distortion

Web Mercator (EPSG:3857) uses "pseudo-meters" that are only accurate at the equator. At higher latitudes, distances become increasingly distorted:

| Latitude | Web Mercator Distance | Ground Distance | Distortion |
|----------|----------------------|-----------------|------------|
| 0° (Equator) | 204.8m | 204.8m | 0% |
| 30° | 204.8m | ~177m | 13% |
| 45° | 204.8m | ~145m | 29% |
| 60° | 204.8m | ~102m | 50% |

**Impact on ML Training:**

- ❌ Inconsistent pixel density across latitudes
- ❌ Export script GSD validation failures
- ❌ Patches too small when exported to UTM

### Solution: Latitude-Based Scale Correction

We create patches with Web Mercator dimensions that compensate for latitude distortion:

```typescript
// Core formula (src/utils/geodesic.ts)
const scaleFactor = 1 / Math.cos(latitudeRadians);
const webMercatorSize = targetGroundMeters * scaleFactor;
```

### Implementation

**File:** `src/utils/geodesic.ts`

```typescript
/**
 * Creates a geodesically-correct square patch
 * @param centerX - Web Mercator X coordinate
 * @param centerY - Web Mercator Y coordinate
 * @param targetGroundMeters - Desired ground distance (e.g., 204.8m)
 * @returns GeoJSON Polygon with latitude-corrected dimensions
 */
export function createGeodesicSquare(
  centerX: number,
  centerY: number,
  targetGroundMeters: number
): GeoJSON.Polygon {
  // Convert Web Mercator Y to latitude
  const latitude = webMercatorYToLatitude(centerY);
  const latitudeRadians = (latitude * Math.PI) / 180;
  
  // Calculate scale factor at this latitude
  const scaleFactor = 1 / Math.cos(latitudeRadians);
  
  // Web Mercator size needed to achieve target ground distance
  const webMercatorSize = targetGroundMeters * scaleFactor;
  
  // Create square centered at the given point
  const halfSize = webMercatorSize / 2;
  
  return {
    type: "Polygon",
    coordinates: [[
      [centerX - halfSize, centerY - halfSize],
      [centerX + halfSize, centerY - halfSize],
      [centerX + halfSize, centerY + halfSize],
      [centerX - halfSize, centerY + halfSize],
      [centerX - halfSize, centerY - halfSize],
    ]],
  };
}

/**
 * Get target ground size for a resolution
 */
export function getTargetGroundSize(resolutionCm: 20 | 10 | 5): number {
  // 20cm resolution = 1024 pixels × 0.2m = 204.8m
  // 10cm resolution = 1024 pixels × 0.1m = 102.4m
  // 5cm resolution = 1024 pixels × 0.05m = 51.2m
  return (1024 * resolutionCm) / 100;
}

/**
 * Verify actual ground dimensions using geodesic calculation
 * (Useful for debugging and validation)
 */
export function verifyGroundDimensions(polygon: GeoJSON.Polygon): {
  width: number;
  height: number;
  diagonal: number;
} {
  const coords = polygon.coordinates[0];
  const [bottomLeft, bottomRight, topRight, topLeft] = coords;
  
  // Convert to lon/lat for geodesic calculations
  const bl = webMercatorToLonLat(bottomLeft);
  const br = webMercatorToLonLat(bottomRight);
  const tr = webMercatorToLonLat(topRight);
  const tl = webMercatorToLonLat(topLeft);
  
  // Use OpenLayers geodesic distance functions
  return {
    width: getDistance(bl, br),
    height: getDistance(bl, tl),
    diagonal: getDistance(bl, tr),
  };
}
```

### Usage in Components

**Before:**

```typescript
// ❌ Creates patches with incorrect dimensions at higher latitudes
const targetSizeMeters = 204.8;
const patchGeometry = {
  type: "Polygon",
  coordinates: [[
    [centerX - targetSizeMeters/2, centerY - targetSizeMeters/2],
    [centerX + targetSizeMeters/2, centerY - targetSizeMeters/2],
    [centerX + targetSizeMeters/2, centerY + targetSizeMeters/2],
    [centerX - targetSizeMeters/2, centerY + targetSizeMeters/2],
    [centerX - targetSizeMeters/2, centerY - targetSizeMeters/2],
  ]],
};
```

**After:**

```typescript
// ✅ Creates patches with correct ground dimensions
import { createGeodesicSquare, getTargetGroundSize } from "@/utils/geodesic";

const targetGroundSize = getTargetGroundSize(20); // 204.8m
const patchGeometry = createGeodesicSquare(centerX, centerY, targetGroundSize);
```

### Validation Tool

The editor includes a distance measurement tool to verify patch dimensions:

1. Click **"📏 Measure Distance"** button in the map toolbar
2. Draw a line across patch boundaries
3. Distance shown uses **geodesic calculation** (true ground distance)
4. Verify patches show ~204.8m (not ~130m at high latitudes)

---

## Layer-Specific Validation

### Rationale

ML model predictions need independent validation:

- **Deadwood predictions** may be accurate while forest cover needs correction
- **Forest cover predictions** may be perfect while deadwood needs editing
- Users can focus on one layer at a time, reducing cognitive load

### Validation States

Each patch tracks validation independently per layer:

```typescript
interface IReferencePatch {
  // null = pending validation
  // true = validated as good
  // false = validated as bad (needs correction)
  deadwood_validated: boolean | null;
  forest_cover_validated: boolean | null;
}
```

### User Workflow

#### Option 1: Validate by Layer (Recommended)

1. **Phase 1: Validate all deadwood**
   - Select "Deadwood" layer (keyboard: `2`)
   - Review and validate all 16× 5cm patches (press `Q` for good, `R` for bad)
   - System auto-advances to next pending deadwood patch

2. **Phase 2: Validate all forest cover**
   - Switch to "Forest Cover" layer (keyboard: `3`)
   - Review and validate all 16× 5cm patches (press `Q` for good, `R` for bad)
   - System auto-advances to next pending forest cover patch

#### Option 2: Validate by Patch

1. Select first patch
2. Validate deadwood (press `2`, then `Q` or `R`)
3. Switch to forest cover (press `3`, then `Q` or `R`)
4. Auto-advance to next patch
5. Repeat

### Progress Tracking

The sidebar displays two independent progress bars:

```typescript
// Deadwood Progress
{
  total: 16,              // Total 5cm patches
  validated: 12,          // Validated (good or bad)
  percentage: 75,
}

// Forest Cover Progress
{
  total: 16,
  validated: 8,
  percentage: 50,
}
```

**Visual Design:**

- Active layer's progress bar is emphasized (thicker stroke, colored)
- Deadwood uses blue (#1890ff)
- Forest Cover uses green (#52c41a)
- Inactive layer shows in gray

---

## Reference Geometry Management

### Separate Storage Tables

Reference geometries are stored in dedicated tables, isolated from model predictions:

**Benefits:**

1. ✅ **Protected from model re-runs** - ML pipeline can regenerate predictions without affecting validated reference data
2. ✅ **Version control** - Each edit creates a new version, previous versions retained
3. ✅ **Simpler queries** - Direct table access, no `label_source` filtering needed

### Reference Geometry Lifecycle

#### 1. Initial Creation (Auto-Copy from Predictions)

When user clicks "Generate Sub-patches":

```typescript
// Extract model predictions within patch bbox
const predictions = await extractPredictionsInBBox(
  datasetId,
  'deadwood',
  [bbox_minx, bbox_miny, bbox_maxx, bbox_maxy],
  10  // 10m buffer to capture edge features
);

// Create v2_labels entry
const label = await createLabel({
  label_source: 'reference_patch',
  reference_patch_id: basePatchId,
  label_data: 'deadwood',
  version: 1,
  is_active: true,
});

// Store geometries in separate table
await insertGeometries(
  'reference_patch_deadwood_geometries',
  label.id,
  predictions
);

// Link to patch
await updatePatch(basePatchId, {
  reference_deadwood_label_id: label.id,
});
```

#### 2. Editing Session

When user clicks "Edit Deadwood":

1. **Load reference geometries** from `reference_patch_deadwood_geometries`
2. **Display in editable overlay** (OpenLayers VectorLayer)
3. **User performs edits**:
   - Draw new polygons
   - Modify vertices (drag/reshape)
   - Delete polygons
   - Merge overlapping polygons
   - Cut holes in polygons
   - AI segmentation (SAM-based)

4. **Save creates new version**:
   - Mark old label as `is_active=false`
   - Create new label with `version=2`, `parent_label_id=old_label_id`
   - Insert edited geometries with new `label_id`
   - Update patch's `reference_deadwood_label_id`

#### 3. Version History & Revert

Users can revert to previous versions:

```
Version Timeline:
├─ v1 (auto-copied) - 18 polygons
├─ v2 (edited) - 15 polygons
├─ v3 (edited) - 17 polygons ← current
└─ (can revert to v1 or v2)
```

Revert creates a new version that clones the target version's geometries:

```typescript
// Revert to v2
await revertToVersion(patchId, 'deadwood', 2);

// Creates:
// v4 - 15 polygons (cloned from v2)
// v3 marked as is_active=false
```

### Base Patch Inheritance

**Critical Pattern:**

- Only **base patches (20cm)** store `reference_deadwood_label_id` and `reference_forest_cover_label_id`
- Sub-patches (10cm, 5cm) **inherit** reference data by walking up the parent chain

```typescript
function findBasePatchForSelected(patch: IReferencePatch): IReferencePatch | null {
  if (patch.resolution_cm === 20 && !patch.parent_tile_id) {
    return patch; // Already base patch
  }
  
  // Walk up parent chain
  let current = patch;
  while (current.parent_tile_id) {
    const parent = patches.find(p => p.id === current.parent_tile_id);
    if (!parent) break;
    current = parent;
  }
  
  return current.resolution_cm === 20 ? current : null;
}
```

**Implication:**

- Edits always apply to the base patch
- All 16× 5cm sub-patches see the same reference data
- No duplicate storage

---

## Polygon Editing Integration

### Modal Editing UX

The editor uses a **modal design** - sidebar and editing toolbar are mutually exclusive:

**Normal Mode (Viewing):**
- Sidebar visible with patch details
- Layer radio buttons active (Deadwood / Forest Cover / Ortho Only)
- "Edit [Layer]" button available
- Reference geometries displayed as read-only

**Editing Mode:**
- Sidebar hidden
- Editing toolbar appears (top-right floating)
- Layer radio buttons hidden
- Reference geometries loaded into editable overlay

### Editing Tools

**Basic Tools:**
- **Select/Modify** - Click to select, drag vertices to reshape
- **Draw** - Create new polygons (click to add vertices, double-click to finish)
- **Delete** - Remove selected polygons
- **Clear All** - Remove all polygons in overlay

**Advanced Tools:**
- **Merge** - Combine two overlapping polygons into one
- **Cut Hole** - Subtract area from polygon (e.g., exclude non-deadwood areas)
- **AI Segment** - Draw bounding box, get SAM predictions

### Boolean Geometry Operations

Uses `polygon-clipping` library (Martinez algorithm):

```typescript
// Merge (union) - requires exactly 2 selected, intersecting polygons
export function mergePolygons(poly1: Polygon, poly2: Polygon): Polygon | MultiPolygon {
  const rings1 = polygonToRings(poly1);
  const rings2 = polygonToRings(poly2);
  const result = union(rings1, rings2);
  return ringsToGeometry(result);
}

// Cut hole (difference) - requires 1 selected polygon + drawn hole
export function cutHole(polygon: Polygon, hole: Polygon): Polygon | MultiPolygon {
  const polyRings = polygonToRings(polygon);
  const holeRings = polygonToRings(hole);
  const result = difference(polyRings, holeRings);
  return ringsToGeometry(result);
}
```

### AI Segmentation

Integrated with Segment Anything Model (SAM):

1. User enables AI mode
2. User draws bounding box around object
3. System captures orthophoto region
4. Sends to SAM API
5. Returns polygon predictions
6. User can select/edit/merge results

---

## Keyboard Shortcuts

| Key | Action | Mode |
|-----|--------|------|
| `1` | Select "Ortho Only" layer | Normal |
| `2` | Select "Deadwood" layer | Normal |
| `3` | Select "Forest Cover" layer | Normal |
| `Q` | Mark current layer as validated (good) | Normal |
| `R` | Mark current layer as bad | Normal |
| `←` / `→` | Navigate previous/next patch | Normal |
| `Esc` | Deselect patch | Normal |
| `E` | Enter editing mode | Normal |
| `Ctrl+S` | Save edits | Editing |
| `Esc` | Cancel editing | Editing |

---

## Export & ML Training Pipeline

### Export Format

Patches are exported to **UTM projection** for ML training:

1. **Frontend stores**:
   - Geometry in EPSG:3857 (Web Mercator, geodesically-corrected)
   - `utm_zone` and `epsg_code` metadata

2. **Export script** (`scripts/export_ml_tiles.py`):
   - Reads bbox from database
   - Transforms to UTM using stored EPSG code
   - Clips orthophoto to exact patch boundary
   - Validates GSD (ground sample distance) matches target resolution

3. **Output**:
   - GeoTIFF: 1024×1024 pixels at target resolution (e.g., 0.2m for 20cm)
   - Reference geometries exported as GeoJSON in same UTM projection
   - Metadata JSON with validation results

### GSD Validation

The export script validates pixel density:

```python
# For 20cm resolution patch (204.8m × 204.8m)
expected_gsd = 0.2  # meters per pixel
actual_gsd = ground_width / 1024

if abs(actual_gsd - expected_gsd) > 0.01:
    raise ValidationError("GSD mismatch")
```

**Result:** After geodesic correction implementation, all patches pass GSD validation.

---

## Testing & Validation

### Manual Testing Checklist

**Patch Creation:**
- ✅ Place 20cm base patch at different latitudes (equator, 30°, 45°, 60°)
- ✅ Use measuring tool to verify ground dimensions (~204.8m)
- ✅ Generate sub-patches (10cm, 5cm) and verify dimensions
- ✅ Check UTM zone is correctly calculated and stored

**Layer Validation:**
- ✅ Validate deadwood layer only (forest cover should remain pending)
- ✅ Validate forest cover layer only (deadwood should remain pending)
- ✅ Progress bars update independently
- ✅ Auto-advance finds next pending patch for active layer

**Polygon Editing:**
- ✅ Edit reference geometries (draw, modify, delete)
- ✅ Merge two overlapping polygons
- ✅ Cut hole in polygon
- ✅ Use AI segmentation
- ✅ Save creates new version
- ✅ Revert to previous version

**Export:**
- ✅ Export patches at different latitudes
- ✅ Verify GeoTIFF dimensions (1024×1024)
- ✅ Verify GSD matches target resolution
- ✅ Verify reference geometries align with raster

---

## Performance Considerations

### Efficient Layer Rendering

**Problem:** Switching between layers requires fetching geometries from database

**Solution:** Cache reference geometries per patch:

```typescript
const referenceCache = useRef<Map<number, {
  deadwood: GeoJSON.Feature[],
  forestCover: GeoJSON.Feature[]
}>>(new Map());

// Fetch once, cache, reuse
const loadReferenceGeometries = async (patchId: number, layer: 'deadwood' | 'forest_cover') => {
  const cached = referenceCache.current.get(patchId)?.[layer];
  if (cached) return cached;
  
  const geometries = await fetchGeometriesFromTable(
    layer === 'deadwood' 
      ? 'reference_patch_deadwood_geometries'
      : 'reference_patch_forest_cover_geometries',
    patchId
  );
  
  // Update cache
  const patchCache = referenceCache.current.get(patchId) || {};
  patchCache[layer] = geometries;
  referenceCache.current.set(patchId, patchCache);
  
  return geometries;
};
```

### Polygon Editing Performance

**Challenge:** Large number of vertices in overlay

**Optimizations:**
- Use `ol/interaction/Modify` with `pixelTolerance` for easier vertex selection
- Debounce style recalculations during dragging
- Use `requestAnimationFrame` for hover highlighting
- Simplify geometries on save (remove collinear points)

---

## Migration Notes

### From ML Tiles to Reference Patches

The system was renamed from "ML Training Tiles" to "Reference Patches":

**Database:**
- Table renamed: `ml_training_tiles` → `reference_patches`
- Column renamed: `tile_index` → `patch_index`

**Code:**
- Types: `IMLTile` → `IReferencePatch`
- Hooks: `useMLTiles` → `useReferencePatches`
- Routes: `/ml-tiles` → `/reference-patches`

**Backwards Compatibility:**
- Old `status` column (`"pending" | "good" | "bad"`) deprecated
- New validation flags (`deadwood_validated`, `forest_cover_validated`) take precedence
- Migration script sets validation flags based on old status

---

## Key Files

### Utilities
- `src/utils/geodesic.ts` - Geodesic calculations for patch placement
- `src/utils/geometry.ts` - Boolean operations (merge, cut hole)
- `src/utils/projection.ts` - UTM zone calculation

### Hooks
- `src/hooks/useReferencePatches.ts` - CRUD operations for patches
- `src/hooks/usePolygonEditor.tsx` - Polygon editing state machine
- `src/hooks/useAISegmentation.tsx` - SAM integration

### Components
- `src/components/ReferencePatches/ReferencePatchEditorView.tsx` - Main container
- `src/components/ReferencePatches/ReferencePatchMap.tsx` - Map with layer management
- `src/components/ReferencePatches/PatchDetailSidebar.tsx` - Patch details & validation
- `src/components/ReferencePatches/placement/PatchPlacementPhase.tsx` - Interactive patch placement
- `src/components/ReferencePatches/EditorToolbar.tsx` - Polygon editing controls

### Pages
- `src/pages/DatasetReferencePatchEditor.tsx` - Route `/datasets/:id/reference-patches`

---

## Future Improvements

### Planned
- [ ] Undo/redo for polygon editing
- [ ] Snapping to existing geometry edges
- [ ] Batch validation (mark multiple patches at once)
- [ ] Export validation report (coverage statistics, QA metrics)

### Under Consideration
- [ ] Support for 2.5cm super-resolution patches
- [ ] Multi-user collaboration (lock patches during editing)
- [ ] Automated quality metrics (polygon simplicity, overlap detection)
- [ ] Integration with annotation platforms (Label Studio, CVAT)

---

## References

- **Web Mercator Projection**: [EPSG:3857](https://epsg.io/3857)
- **UTM Projection**: [Universal Transverse Mercator](https://en.wikipedia.org/wiki/Universal_Transverse_Mercator_coordinate_system)
- **OpenLayers Geodesic**: [ol/sphere.getDistance()](https://openlayers.org/en/latest/apidoc/module-ol_sphere.html#.getDistance)
- **Segment Anything Model**: [SAM by Meta](https://segment-anything.com/)

