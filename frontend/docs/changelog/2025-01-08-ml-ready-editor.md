# ML-Ready Editor - 2025-01-08

## New Feature: ML-Ready Tile Editor

Added a unified interface for reviewing and marking ML training tiles with optimized keyboard controls for rapid data labeling workflows.

### How It Works

1. **Base Tile Generation**: Create 20cm base tiles by dragging them over the AOI, then generate nested 10cm and 5cm sub-tiles
2. **Tile Review**: Navigate through tiles and mark them as "good" or "bad" for ML training
3. **Automatic Progression**: System automatically advances to the next pending tile after marking, completing each resolution before moving to the next
4. **Quality Validation**: Only tiles with 60%+ AOI coverage are accepted, and overlaps are prevented

### Keyboard Controls

**Left Hand (Marking):**

- `SPACE` - Mark tile as good
- `F` - Mark tile as bad

**Right Hand (Layers & Navigation):**

- `J` - Toggle AOI layer
- `K` - Toggle Deadwood predictions
- `L` - Toggle Forest Cover predictions
- `Arrow Keys` - Navigate between tiles

### Visual Feedback

- Tiles display colored borders: gray (pending), green (good), red (bad), blue (selected)
- 250ms visual feedback delay shows button selection before auto-advancing
- Progress indicators track completion per resolution (10cm and 5cm)
- All tiles are fully transparent to see underlying imagery and predictions

### Workflow

1. Auditor marks a dataset as audit-complete
2. Navigate to "Tiles Pending" tab and click "Generate ML Tiles"
3. Position base tile(s) to cover the AOI, generate sub-tiles
4. Review each 10cm tile (mark good/bad), system wraps to complete all tiles in resolution
5. Automatically advances to 5cm tiles when 10cm is complete
6. Mark dataset as "ML tiles complete" when finished

### Export & Pixel-Perfect Alignment

ML-ready tiles are exported with guaranteed pixel-perfect alignment between RGB imagery and prediction masks:

**Coordinate System Strategy:**

- All tiles stored in **EPSG:3857** (Web Mercator) to match the COG projection
- Bounding boxes designed so `bbox_width_meters / 1024 = target_GSD` (e.g., 204.8m / 1024 = 0.20m/px for 20cm tiles)
- No reprojection during export - everything stays in EPSG:3857 to avoid resampling artifacts

**Export Process:**

1. **RGB Extraction**: Use `gdal_translate` with `-projwin` to crop COG using exact bbox in EPSG:3857, resample to exactly 1024×1024 with bilinear interpolation
2. **Mask Rendering**: Render prediction vectors (deadwood/forest cover) to 1024×1024 rasters using identical bbox and EPSG:3857
3. **Validation**: Assert `(bbox_width_m / 1024) == target_GSD_m` within tolerance; reject tiles outside COG extent

**Export Format:**

- `{dataset_id}_{tile_index}_{resolution}cm_RGB.png` (1024×1024 RGB)
- `{dataset_id}_{tile_index}_{resolution}cm_deadwood.png` (1024×1024 grayscale mask)
- `{dataset_id}_{tile_index}_{resolution}cm_forestcover.png` (1024×1024 grayscale mask)
- `{dataset_id}_{tile_index}_{resolution}cm.json` (metadata: bbox_3857, effective_gsd_m, coverage stats)

**Why This Works:**

- COGs are already in EPSG:3857 with known resolution (from `cog_info.GEO.Resolution`)
- Predictions stored in EPSG:3857 (PostGIS geometry)
- Export uses **same projection, same bbox, same output dimensions** for all three images
- Result: Pixel (x,y) in RGB exactly matches pixel (x,y) in both masks with sub-pixel accuracy

**Note on Latitude Distortion:** EPSG:3857 has latitude-dependent scale distortion, but this is consistent across all three outputs since they share the same bbox. For training, relative spatial relationships are preserved. If absolute ground-meter accuracy is critical, a future enhancement could warp to local UTM before export.
