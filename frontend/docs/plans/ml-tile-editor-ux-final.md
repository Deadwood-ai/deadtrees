# ML Tile Label Editor - Final UX Specification

## Executive Summary

Integrate polygon editing into ML Tile QA workflow with modal editing UI, type-specific editing sessions, and automatic reference geometry versioning.

---

## Problem Context & Goals

### The Challenge

ML models generate predictions for deadwood and forest cover geometries. However:

1. **Model predictions need human validation and correction** before being used as training data
2. **Re-running models would delete user corrections** if not properly separated from predictions
3. **Training tiles need curated reference data** that remains stable across model iterations
4. **Users need to edit geometries within specific tile boundaries** to maintain spatial organization

### The Solution

Create a **tile-based reference labeling system** that:

- ✅ Stores user-corrected geometries separately from model predictions (`label_source='manual_correction'`)
- ✅ Links reference data to specific ML training tiles (per-tile versioning)
- ✅ Allows editing at any resolution (20cm base tiles, 10cm, or 5cm sub-tiles)
- ✅ Provides version control with revert capabilities
- ✅ Maintains a clean modal editing UX (sidebar ↔ toolbar)

---

## User Workflows & Scenarios

### Workflow 1: Creating a New ML Training Tile Set

**Starting Point**: User has a dataset with model predictions (deadwood + forest cover) already generated.

**Steps**:

1. User navigates to Dataset ML Tiles page
2. Map displays global model predictions (MVT layers)
3. User clicks "Add Base Tile"
4. User positions 20cm base tile (with optional translate for precise placement)
5. User clicks "Generate Sub-tiles"
6. **System auto-copies predictions within tile bbox** → creates reference v1
7. System generates 4x 10cm + 16x 5cm nested tiles
8. Base tile marked as "good"
9. User auto-selected to first 10cm sub-tile for QA

**Result**: Base tile now has `reference_deadwood_label_id` and `reference_forest_cover_label_id` pointing to version 1 labels.

---

### Workflow 2: Editing Reference Geometries (First Time)

**Starting Point**: Base tile with reference data (from Workflow 1).

**Steps**:

1. User selects base tile (or any sub-tile)
2. Sidebar shows tile details + "Edit Deadwood" / "Edit Forest Cover" buttons
3. User clicks "Edit Deadwood"
4. **Sidebar hides, editing toolbar appears (top-right)**
5. Map overlay shows existing deadwood geometries (loaded from reference)
6. User performs edits:
   - Draw new polygons
   - Modify existing polygons (drag vertices)
   - Delete unwanted polygons
   - Merge overlapping polygons
   - Cut holes in polygons
   - Use AI segmentation (draw bbox, get SAM predictions)
7. User clicks "Save" in toolbar
8. **System creates version 2** of reference label (keeps v1 for revert)
9. Toolbar hides, sidebar returns
10. Map updates to show new reference geometries

**Result**: Base tile's `reference_deadwood_label_id` now points to version 2.

---

### Workflow 3: Editing from a Sub-tile

**Starting Point**: User is viewing a 10cm or 5cm sub-tile.

**Steps**:

1. User selects 10cm sub-tile (e.g., during QA workflow)
2. Sidebar shows sub-tile details + "Edit Deadwood" / "Edit Forest Cover" buttons
3. User clicks "Edit Forest Cover"
4. **System walks up parent chain to find base tile (20cm)**
5. System loads base tile's forest cover reference geometries
6. Editing toolbar appears, user edits
7. User clicks "Save"
8. **System updates BASE tile's reference** (not sub-tile)
9. All sub-tiles inherit the updated reference

**Result**: Edits always apply to base tile, maintaining consistency across all nested tiles.

---

### Workflow 4: Reverting to Previous Version

**Starting Point**: User has edited reference multiple times (v1, v2, v3...).

**Steps**:

1. User selects base tile
2. Sidebar shows edit buttons + "Version History" collapsible
3. User expands "Version History"
4. Timeline shows:
   ```
   v3 (current) - 2025-10-09 15:30 | 15 polygons
   v2 - 2025-10-09 14:45 | 18 polygons | [Revert]
   v1 - 2025-10-09 14:15 | 18 polygons | [Revert]
   ```
5. User clicks "Revert" on v2
6. System:
   - Marks v3 as `is_active=false`
   - Clones v2 geometries as new v4 with `is_active=true`
   - Updates tile's `reference_*_label_id` to v4
7. Map refreshes, showing v2 geometries

**Result**: User can undo mistakes without losing history.

---

### Workflow 5: Working with Multiple Base Tiles

**Starting Point**: User has created 3 base tiles in different areas of the dataset.

**Steps**:

1. User selects Tile #1 → sidebar shows, reference geometries display
2. User edits Tile #1 deadwood → saves
3. User deselects Tile #1 (clicks elsewhere on map)
4. **Map switches to show global predictions** (no reference visible)
5. User selects Tile #2 → sidebar shows, Tile #2 reference geometries display
6. User edits Tile #2 forest cover → saves
7. User cycles through tiles for QA

**Result**: Each base tile maintains independent reference data. No cross-contamination.

---

### Workflow 6: Completing the Dataset

**Starting Point**: User has finished QA on all tiles.

**Steps**:

1. User marks all tiles as "good" or "bad"
2. User clicks "Complete" button in header
3. System marks dataset as complete (`isCompleted=true`)
4. **Edit buttons hide** (no further editing allowed)
5. Reference data is now locked and ready for:
   - ML training export
   - Publication
   - Data sharing

**Result**: Curated reference dataset protected from further changes.

---

## State Transitions & Data Flow

### Application State Machine

```
┌─────────────────┐
│ NO TILE SELECTED│
│ - Show MVT pred │
│ - Add Tile btn  │
└────────┬────────┘
         │ (select tile)
         ▼
┌─────────────────────────┐
│ TILE SELECTED (Normal)  │
│ - Show reference layers │
│ - Sidebar visible       │
│ - Edit buttons available│
└─────┬──────────────┬────┘
      │              │
      │ (edit btn)   │ (deselect)
      ▼              │
┌───────────────┐    │
│ EDITING MODE  │    │
│ - Toolbar vis │    │
│ - Sidebar hide│    │
│ - Overlay edit│    │
└─────┬─────────┘    │
      │ (save/cancel)│
      └──────────────┘
```

### Data Flow: Reference Creation

```
Model Predictions (MVT)
  │
  │ (user clicks "Generate Sub-tiles")
  ▼
Extract geometries within tile bbox
  │
  ▼
Create v2_labels entry
  - label_source='manual_correction'
  - ml_tile_id=42
  - label_data='deadwood'
  - version=1
  │
  ▼
Insert geometries to v2_deadwood_geometries
  - label_id=100 (references v2_labels)
  - geometry (PostGIS)
  │
  ▼
Update ml_training_tiles
  - reference_deadwood_label_id=100
```

### Data Flow: Editing Session

```
User clicks "Edit Deadwood"
  │
  ▼
Fetch geometries:
  SELECT g.* FROM v2_deadwood_geometries g
  JOIN v2_labels l ON g.label_id = l.id
  WHERE l.ml_tile_id = 42
    AND l.label_data = 'deadwood'
    AND l.is_active = true
  │
  ▼
Load into OpenLayers overlay (editable)
  │
  ▼
User edits (draw, modify, delete, merge, AI segment)
  │
  ▼
User clicks "Save"
  │
  ▼
Extract features from overlay
  │
  ▼
Clip to tile bbox (with 10m buffer)
  │
  ▼
Create NEW v2_labels entry
  - parent_label_id=100 (previous version)
  - version=2
  - is_active=true
  │
  ▼
Mark old label as inactive
  UPDATE v2_labels SET is_active=false WHERE id=100
  │
  ▼
Insert new geometries
  │
  ▼
Update tile reference
  UPDATE ml_training_tiles
  SET reference_deadwood_label_id=101
  WHERE id=42
```

---

## Layer Display Logic (Critical)

### When NO tile is selected:

```typescript
// Show global model predictions (MVT)
deadwoodLayerRef.current?.setVisible(showDeadwood);
forestCoverLayerRef.current?.setVisible(showForestCover);

// Reference layers hidden
referenceLayers.deadwood?.setVisible(false);
referenceLayers.forestCover?.setVisible(false);
```

### When tile IS selected (Normal Mode):

```typescript
// Hide global predictions
deadwoodLayerRef.current?.setVisible(false);
forestCoverLayerRef.current?.setVisible(false);

// Show tile-specific reference
if (baseTile.reference_deadwood_label_id && showDeadwood) {
  const geoms = await fetchGeometriesForLabel(baseTile.reference_deadwood_label_id);
  displayAsVectorLayer(geoms, "deadwood");
}

if (baseTile.reference_forest_cover_label_id && showForestCover) {
  const geoms = await fetchGeometriesForLabel(baseTile.reference_forest_cover_label_id);
  displayAsVectorLayer(geoms, "forest_cover");
}
```

### When EDITING mode active:

```typescript
// Hide layer toggles
setLayerTogglesVisible(false);

// Hide reference layers (overlay takes over)
referenceLayers.deadwood?.setVisible(false);
referenceLayers.forestCover?.setVisible(false);

// Show only overlay (editable)
editor.getOverlayLayer()?.setVisible(true);
```

---

## Key Technical Concepts

### 1. Base Tile vs Sub-tile Hierarchy

```
Base Tile (20cm)  id=1, tile_index="20_0"
├─ 10cm Tile     id=2, tile_index="20_0_0", parent_tile_id=1
├─ 10cm Tile     id=3, tile_index="20_0_1", parent_tile_id=1
├─ 10cm Tile     id=4, tile_index="20_0_2", parent_tile_id=1
└─ 10cm Tile     id=5, tile_index="20_0_3", parent_tile_id=1
    ├─ 5cm Tile  id=6, tile_index="20_0_3_0", parent_tile_id=5
    ├─ 5cm Tile  id=7, tile_index="20_0_3_1", parent_tile_id=5
    ├─ 5cm Tile  id=8, tile_index="20_0_3_2", parent_tile_id=5
    └─ 5cm Tile  id=9, tile_index="20_0_3_3", parent_tile_id=5
```

**Critical**: Only base tiles (20cm) have `reference_*_label_id`. Sub-tiles inherit by walking up the parent chain.

### 2. Label Versioning Pattern

```
v2_labels table:
id=100, ml_tile_id=42, version=1, parent_label_id=NULL, is_active=FALSE
id=101, ml_tile_id=42, version=2, parent_label_id=100, is_active=FALSE
id=102, ml_tile_id=42, version=3, parent_label_id=101, is_active=TRUE  ← current

Revert to v2 → creates:
id=103, ml_tile_id=42, version=4, parent_label_id=101, is_active=TRUE
(clones geometries from label_id=101)
```

### 3. Label Source Protection

```sql
-- Model predictions (vulnerable to deletion on re-run)
label_source = 'model_prediction'

-- User-corrected reference (protected)
label_source = 'manual_correction'

-- When model re-runs:
DELETE FROM v2_labels WHERE label_source='model_prediction' AND dataset_id=123;
-- ✅ manual_correction labels are SAFE
```

### 4. Geometry Clipping with Buffer

```typescript
// Tile bbox: [minx, miny, maxx, maxy]
const tileBBox = [100, 200, 300, 400];

// Add 10m buffer to capture polygons slightly outside
const bufferedBBox = [90, 190, 310, 410];

// Clip overlay features to buffered bbox
const clippedGeoms = features
  .filter((f) => intersects(f.getExtent(), bufferedBBox))
  .map((f) => geoJsonFormatter.writeGeometryObject(f.getGeometry()));
```

**Why buffer?** Polygons on tile edges may extend slightly beyond. Buffer ensures we don't lose partial features.

---

## Architecture Decisions (CONFIRMED)

### 1. Reference Data Rendering

**Decision**: Direct VectorLayer (not MVT)

- Fetch geometries directly from `v2_deadwood_geometries` / `v2_forest_cover_geometries`
- Render as OpenLayers VectorLayer
- Simpler, faster for small tile areas

### 2. Layer Type Distinction

**Decision**: Known from direct query

- Separate queries for deadwood vs forest cover
- Tag features with `label_data` property for tracking

### 3. Layer Toggles During Editing

**Decision**: Hide completely

- Layer toggles (AOI/Deadwood/Forest) hidden when `editingMode !== null`
- Restored when editing ends

### 4. Editing UI Layout (MODAL DESIGN)

**Decision**: Sidebar ↔ Toolbar exclusive visibility

```
NORMAL MODE:
┌─────────────────────────────────┐
│ Map                    Sidebar  │
│ [Layer toggles visible]         │
│                        [Edit Deadwood]    │
│                        [Edit Forest Cover]│
│                        [Version History]  │
└─────────────────────────────────┘

EDITING MODE:
┌─────────────────────────────────┐
│ Map              [Toolbar]      │
│ [Layer toggles HIDDEN]          │
│                  [Draw/Modify/  │
│                   AI/Save/Cancel│
│                   Delete/Merge] │
│ [Sidebar HIDDEN]                │
└─────────────────────────────────┘
```

**Flow**:

1. User clicks "Edit Deadwood" OR "Edit Forest Cover" in sidebar
2. Sidebar slides out/hides
3. Editing toolbar appears (top-right, floating)
4. User edits polygons
5. User clicks "Save" in toolbar → toolbar hides, sidebar returns
6. OR user clicks "Cancel" → discard changes, sidebar returns

### 5. Edit at Any Resolution

**Decision**: Can edit from 20cm, 10cm, OR 5cm tiles

- Always edits the BASE tile's reference (walks up parent chain)
- Sub-tiles inherit parent's reference
- Edit buttons visible at all resolutions

### 6. Initial Reference Creation

**Decision**: Auto-copy predictions

- First "Generate Sub-tiles" click → auto-copy predictions within bbox as v1 reference
- Creates `v2_labels` with `label_source='manual_correction'`
- If user edits before Generate Sub-tiles → overlay captures edits

---

## UI Component Structure

### MLTileUnifiedView (Main Container)

```typescript
const [editingMode, setEditingMode] = useState<'deadwood' | 'forest_cover' | null>(null);
const [layerTogglesVisible, setLayerTogglesVisible] = useState(true);

const editor = usePolygonEditor({ mapRef });
const ai = useAISegmentation({ mapRef, getOrthoLayer, getTargetVectorSource: ... });

return (
  <div className="flex h-full">
    {/* Map */}
    <MLTileMap
      showDeadwood={showDeadwood && layerTogglesVisible}
      showForestCover={showForestCover && layerTogglesVisible}
      onMapReady={setMapRef}
      onGetOrthoLayer={setGetOrthoLayer}
      ...
    />

    {/* Conditional: Sidebar XOR Toolbar */}
    {editingMode ? (
      <EditorToolbar
        position="top-right"
        type={editingMode}
        editor={editor}
        ai={ai}
        onSave={() => handleSaveEdits(editingMode)}
        onCancel={handleCancelEditing}
      />
    ) : (
      selectedTile && (
        <MLTileDetailSidebar
          onEditDeadwood={() => handleStartEditing('deadwood')}
          onEditForestCover={() => handleStartEditing('forest_cover')}
          ...
        />
      )
    )}
  </div>
);
```

### MLTileDetailSidebar (Enhanced)

**New Props**:

```typescript
interface Props {
  // ... existing
  onEditDeadwood?: () => void;
  onEditForestCover?: () => void;
  baseTile: IMLTile; // Always the base tile (20cm)
}
```

**New UI Section** (after Resolution tabs, before Delete):

```tsx
{
  /* Show after Generate Sub-tiles (when reference exists) */
}
{
  baseTile.reference_deadwood_label_id && !isCompleted && (
    <Space direction="vertical" className="mt-4 w-full">
      <Button icon={<EditOutlined />} onClick={onEditDeadwood} block>
        Edit Deadwood
      </Button>

      <Button icon={<EditOutlined />} onClick={onEditForestCover} block>
        Edit Forest Cover
      </Button>

      {/* Version History (collapsible) */}
      <Collapse ghost>
        <Collapse.Panel header="Version History" key="1">
          <VersionHistory tileId={baseTile.id} />
        </Collapse.Panel>
      </Collapse>
    </Space>
  );
}
```

### EditorToolbar (NEW Component)

```typescript
interface Props {
  position: 'top-right' | 'top-left';
  type: 'deadwood' | 'forest_cover';
  editor: ReturnType<typeof usePolygonEditor>;
  ai: ReturnType<typeof useAISegmentation>;
  onSave: () => void;
  onCancel: () => void;
}

export default function EditorToolbar({ position, type, editor, ai, onSave, onCancel }: Props) {
  return (
    <div className={`absolute ${position === 'top-right' ? 'right-4' : 'left-4'} top-4 z-20`}>
      <Card
        title={`Editing ${type === 'deadwood' ? 'Deadwood' : 'Forest Cover'}`}
        className="shadow-lg"
        style={{ width: 300 }}
      >
        {/* Editor Controls */}
        <Space direction="vertical" size="small" className="w-full">
          <Button
            icon={editor.isDrawing ? <StopOutlined /> : <DrawOutlined />}
            onClick={editor.toggleDraw}
            block
          >
            {editor.isDrawing ? 'Stop Draw' : 'Draw'}
          </Button>

          <Button
            icon={<ScissorOutlined />}
            onClick={editor.cutHoleWithDrawn}
            disabled={!editor.selection || editor.selection.length === 0}
            block
          >
            Cut Hole
          </Button>

          <Button
            icon={<MergeOutlined />}
            onClick={editor.mergeSelected}
            disabled={!editor.selection || editor.selection.length < 2}
            block
          >
            Merge Selected
          </Button>

          <Button
            icon={<RobotOutlined />}
            onClick={ai.isActive ? ai.disable : ai.enable}
            loading={ai.isProcessing}
            block
          >
            {ai.isActive ? 'AI Active' : 'AI Segment'}
          </Button>

          <Button
            icon={<DeleteOutlined />}
            onClick={editor.deleteSelected}
            disabled={!editor.selection || editor.selection.length === 0}
            danger
            block
          >
            Delete Selected
          </Button>

          <Divider style={{ margin: '8px 0' }} />

          {/* Save/Cancel */}
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={onSave}
            block
            size="large"
          >
            Save Changes
          </Button>

          <Button
            onClick={onCancel}
            block
          >
            Cancel
          </Button>
        </Space>
      </Card>
    </div>
  );
}
```

---

## Key Functions

### handleStartEditing

```typescript
async function handleStartEditing(type: "deadwood" | "forest_cover") {
  // 1. Find base tile (even if sub-tile selected)
  const baseTile = findBaseTileForSelected(selectedTile);
  if (!baseTile) return;

  // 2. Fetch reference geometries (or auto-copy if none)
  let geometries = await fetchReferenceGeometries(baseTile.id, type);

  if (geometries.length === 0) {
    // No reference yet → auto-copy from predictions
    geometries = await extractPredictionsInBBox(
      datasetId,
      type,
      [baseTile.bbox_minx, baseTile.bbox_miny, baseTile.bbox_maxx, baseTile.bbox_maxy],
      10, // buffer
    );
  }

  // 3. Load into overlay
  const geoJsonFormatter = new GeoJSON();
  const features = geometries.map((g) => {
    const feature = new Feature(geoJsonFormatter.readGeometry(g));
    feature.set("label_data", type);
    feature.set("tile_id", baseTile.id);
    return feature;
  });

  editor.getOverlayLayer()?.getSource()?.addFeatures(features);

  // 4. Activate editing
  editor.startEditing();

  // 5. Enter modal mode
  setEditingMode(type);
  setLayerTogglesVisible(false);
  hideReferenceLayers();

  message.info(`Editing ${type === "deadwood" ? "Deadwood" : "Forest Cover"} - Draw, modify, or delete polygons`);
}
```

### handleSaveEdits

```typescript
async function handleSaveEdits(type: "deadwood" | "forest_cover") {
  const baseTile = findBaseTileForSelected(selectedTile);
  if (!baseTile) return;

  // 1. Get features from overlay
  const features = editor.getOverlayLayer()?.getSource()?.getFeatures() || [];

  // 2. Clip to tile bbox with buffer
  const tileBBox = [baseTile.bbox_minx, baseTile.bbox_miny, baseTile.bbox_maxx, baseTile.bbox_maxy];
  const clippedGeoms = clipFeaturesToBBox(features, tileBBox, 10);

  // 3. Save as new version (or create v1)
  await updateReferenceLabel({
    ml_tile_id: baseTile.id,
    dataset_id: datasetId,
    label_data: type,
    geometries: clippedGeoms,
  });

  // 4. Clean up and exit editing mode
  editor.stopEditing();
  editor.getOverlayLayer()?.getSource()?.clear();
  setEditingMode(null);

  // 5. Restore UI
  setLayerTogglesVisible(true);
  await loadReferenceLayersForTile(baseTile);

  message.success(`${type === "deadwood" ? "Deadwood" : "Forest Cover"} reference updated!`);
}
```

### handleCancelEditing

```typescript
function handleCancelEditing() {
  editor.stopEditing();
  editor.getOverlayLayer()?.getSource()?.clear();
  setEditingMode(null);
  setLayerTogglesVisible(true);

  // Restore reference layers
  const baseTile = findBaseTileForSelected(selectedTile);
  if (baseTile) {
    loadReferenceLayersForTile(baseTile);
  }

  message.info("Editing cancelled - no changes saved");
}
```

### findBaseTileForSelected

```typescript
function findBaseTileForSelected(tile: IMLTile | null): IMLTile | null {
  if (!tile) return null;

  // If already 20cm base tile
  if (tile.resolution_cm === 20 && !tile.parent_tile_id) {
    return tile;
  }

  // Walk up parent chain
  let current = tile;
  while (current.parent_tile_id) {
    const parent = allTiles.find((t) => t.id === current.parent_tile_id);
    if (!parent) break;
    current = parent;
  }

  return current.resolution_cm === 20 ? current : null;
}
```

---

## Database Schema (Migrations)

### Migration 1: ml_training_tiles

```sql
ALTER TABLE ml_training_tiles
  ADD COLUMN reference_deadwood_label_id BIGINT REFERENCES v2_labels(id) ON DELETE SET NULL,
  ADD COLUMN reference_forest_cover_label_id BIGINT REFERENCES v2_labels(id) ON DELETE SET NULL;

CREATE INDEX idx_tiles_ref_deadwood ON ml_training_tiles(reference_deadwood_label_id)
  WHERE reference_deadwood_label_id IS NOT NULL;
CREATE INDEX idx_tiles_ref_forest ON ml_training_tiles(reference_forest_cover_label_id)
  WHERE reference_forest_cover_label_id IS NOT NULL;
```

### Migration 2: v2_labels

```sql
ALTER TABLE v2_labels
  ADD COLUMN ml_tile_id BIGINT REFERENCES ml_training_tiles(id) ON DELETE SET NULL,
  ADD COLUMN version INTEGER DEFAULT 1 NOT NULL,
  ADD COLUMN parent_label_id BIGINT REFERENCES v2_labels(id) ON DELETE SET NULL,
  ADD COLUMN is_active BOOLEAN DEFAULT TRUE NOT NULL;

CREATE INDEX idx_labels_ml_tile ON v2_labels(ml_tile_id) WHERE ml_tile_id IS NOT NULL;
CREATE INDEX idx_labels_version_active ON v2_labels(ml_tile_id, version, is_active);
CREATE INDEX idx_labels_parent ON v2_labels(parent_label_id) WHERE parent_label_id IS NOT NULL;
```

### Migration 3: label_source enum

```sql
ALTER TYPE label_source ADD VALUE IF NOT EXISTS 'manual_correction';
```

---

## Implementation Checklist

### Phase 1: Database & Types

- [ ] Run all 3 migrations
- [ ] Update `types/labels.ts` (ILabelSource, ILabel)
- [ ] Update `types/mlTiles.ts` (IMLTile)

### Phase 2: Hooks & Utilities

- [ ] Create `hooks/useReferenceLabels.ts`
- [ ] Create `utils/geometryClipping.ts`
- [ ] Add `fetchReferenceGeometries` function
- [ ] Add `extractPredictionsInBBox` function

### Phase 3: Map Layer Management

- [ ] MLTileMap: Add reference layer state
- [ ] MLTileMap: Layer switching logic
- [ ] MLTileMap: Expose mapRef and orthoLayer
- [ ] MLTileMap: `loadReferenceLayersForTile` function
- [ ] MLTileMap: `hideReferenceLayers` function

### Phase 4: Editing Integration

- [ ] MLTileUnifiedView: Setup usePolygonEditor and useAISegmentation
- [ ] MLTileUnifiedView: Add editingMode state
- [ ] MLTileUnifiedView: Add layerTogglesVisible state
- [ ] MLTileUnifiedView: Implement handleStartEditing
- [ ] MLTileUnifiedView: Implement handleSaveEdits
- [ ] MLTileUnifiedView: Implement handleCancelEditing
- [ ] MLTileUnifiedView: Add findBaseTileForSelected helper
- [ ] MLTileUnifiedView: Conditional rendering (toolbar vs sidebar)

### Phase 5: UI Components

- [ ] MLTileDetailSidebar: Add edit button props
- [ ] MLTileDetailSidebar: Add "Edit Deadwood" button
- [ ] MLTileDetailSidebar: Add "Edit Forest Cover" button
- [ ] MLTileDetailSidebar: Add version history section
- [ ] Create EditorToolbar component
- [ ] Create VersionHistory component

### Phase 6: Auto-save on Generate

- [ ] MLTileUnifiedView: Update handleGenerateSubTiles
- [ ] Add auto-copy logic (predictions → reference v1)

### Phase 7: Testing

- [ ] Test layer switching
- [ ] Test modal UI transition (sidebar ↔ toolbar)
- [ ] Test editing from sub-tile (edits parent)
- [ ] Test auto-copy on Generate Sub-tiles
- [ ] Test save creates new version
- [ ] Test cancel discards changes
- [ ] Test version history revert
- [ ] Test multiple independent base tiles

---

## Success Criteria

✅ Modal editing UI (sidebar and toolbar mutually exclusive)
✅ Type-specific editing (deadwood OR forest cover per session)
✅ Edit from any resolution (always edits base tile)
✅ Auto-copy predictions as v1 reference
✅ Version control with revert
✅ Clean visual flow (no UI clutter)
✅ No unsaved changes warnings needed (explicit Save/Cancel)
✅ Protected from model reruns (label_source='manual_correction')
