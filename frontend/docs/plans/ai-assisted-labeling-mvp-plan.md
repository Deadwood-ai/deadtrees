## AI‑Assisted Segmentation (Bounding Box) — MVP Implementation Plan

### Goals (MVP)

- Enable users to draw a bounding box on `DatasetDetailsMap` and receive AI‑generated polygon segmentation rendered on the map.
- Use the dataset’s ortho COG as the image source for inference.
- No persistence: visualization‑only; no saving to Supabase yet.
- Pluggable design so the feature can be enabled on other maps later.

---

### Scope & Non‑Goals

- In scope
  - One interaction mode: bounding box prompt → polygons display
  - Draw anywhere in the current view (no AOI restriction for MVP)
  - Show all polygons returned by the API for the given bbox
  - Basic UI: toggle tool on/off, show progress and clear results
- Out of scope (MVP)
  - Persistence to Supabase (labels table)
  - Point prompts / multi‑prompt refinement
  - Class selection / multiple label types
  - Editing/refining returned polygons

---

### User Flow (MVP)

1. User opens `DatasetDetails` and switches to the map (COG visible).
2. User toggles “Segment (Box)” tool in the map controls.
3. User draws a rectangle over the area of interest.
4. App captures an image of the same map view (ortho‑only) at ~1200×1200 px and sends it with the bbox to the SAM endpoint.
5. API returns GeoJSON polygons in pixel coordinates relative to the submitted image.
6. App converts pixel coordinates → map coordinates and renders polygons on a temporary vector layer.
7. User can clear results or draw a new box.

---

### API

- Endpoint: `https://geosense--sam-api-fastapi-app.modal.run/segment`
- Inputs (FormData)
  - `image`: JPEG of the current map view (ortho only)
  - `bboxes`: `[x1, y1, x2, y2]` in the same pixel space as the submitted image
  - `labels`: optional (e.g., `[1]`), default to `[1]` for foreground when using bbox
- Output: GeoJSON `FeatureCollection` of polygons in pixel coordinates (no CRS)

Notes:

- We will keep image size around 1200×1200 px to match performance guidance.

---

### Technical Design

#### Components & Hooks

- `AISegmentationControl` (UI)

  - Small control button group: [Segment (Box)] [Clear]
  - Shows loading state while inference is running
  - Emits enable/disable events and clear action

- `useAISegmentation(mapRef, orthoLayerRef)` (hook)

  - Manages draw interaction (bounding box)
  - On draw end: captures image, posts to API, converts result, returns features
  - Exposes: `isActive`, `isProcessing`, `error`, `enable()`, `disable()`, `clear()`, and `features`

- `aiResultLayer` (vector layer)
  - Temporary display of converted polygon features
  - Distinct style; easy clear

#### Drawing (Bounding Box)

- Use OpenLayers `Draw` with `type: 'Circle'` and `geometryFunction: createBox()` to capture a rectangular extent.
- Record the bbox corners in the map’s pixel space at draw end.

#### Map Image Capture (Ortho‑only)

- Preferred: Temporarily hide all layers except the GeoTIFF ortho layer and capture the current map view as a JPEG at ~1200×1200 px.
- Robust fallback: Create an offscreen OpenLayers map synced to the same `View` and containing only the ortho layer, then export from that canvas. This avoids CORS taint and composition issues and ensures a clean image for the model.
- DevicePixelRatio: Normalize bbox and pixel coords to the actual raster size submitted to the endpoint (use the exact width/height of the image we encode).

Why ortho‑only capture?

- Avoids tainted canvas from third‑party tiles and ensures the segmentation sees only the dataset imagery.
- If all visible layers are known CORS‑safe, we can skip hiding; however, the offscreen‑map approach is robust and predictable.

#### Request Construction

- Build `FormData` with `image` (Blob/JPEG), `bboxes` (JSON array string), and `labels` (default `[1]`).
- POST to the endpoint; handle 5–10s cold start and <1s warm latency.

#### Response Conversion (Pixel → Map Coordinates)

- The GeoJSON contains polygon coordinates in image pixels (no CRS).
- Map each pixel `[x, y]` to map coordinates using `map.getCoordinateFromPixel([x, y])` with the same pixel space as the submitted image.
- DevicePixelRatio and orientation handling:
  - We will ensure the submitted image dimensions are known and map pixels are measured in the identical reference frame.
  - If the API uses a different origin (e.g., center‑origin or y‑up), detect and compensate by translating `(x, y)` by `(width/2, height/2)` and/or flipping y (`y' = height - y`), based on a quick calibration check described below.

Calibration check (first call in session):

- Draw a known bbox; before sending, compute its 4 corners in pixel space and include them in debug logs.
- After receiving polygons, convert two sample points at extremes and confirm visually that overlays align. If misaligned, apply orientation fix (translate/flip) and re‑project once. Cache the determined orientation for the session.

---

### Integration: `DatasetDetailsMap`

- Add `AISegmentationControl` to existing map toolbar in `src/components/DatasetDetailsMap/DatasetDetailsMap.tsx`.
- Use existing `layerRefs` to access the ortho `GeoTIFF` layer and the `Map` instance.
- Append `aiResultLayer` after analysis layers so polygons render on top.

Pluggability

- The hook signature (`useAISegmentation(mapRef, orthoLayerRef)`) lets us reuse it in `DatasetAuditMap` or other map views without changes to business logic.

---

### UX & Styling

- Minimal controls: one toggle button to activate draw mode; one clear button.
- While processing: show a small inline spinner and disable the draw button.
- Style polygons with a bright semi‑transparent fill and clear stroke.
- Non‑blocking: users can pan/zoom while waiting; result renders when ready.

---

### Error Handling & Edge Cases

- API errors/timeouts: show a brief message; keep the drawn bbox so the user can retry.
- Empty or degenerate polygons: ignore with a message.
- Very dense polygons: optionally simplify on the client to keep performance smooth.
- If ortho layer is not available (no `cog_path`), disable the control and show an info tooltip.

---

### Risks & Mitigations

- WebGL or CORS tainting prevents canvas export
  - Mitigate with offscreen map containing only COG tiles with proper CORS.
- Pixel origin/orientation mismatch from API
  - Mitigate with one‑time calibration (translate/flip) and cache the mode.
- DevicePixelRatio scaling differences
  - Always use the exact submitted image width/height for pixel math; normalize coordinates from CSS pixels to raster pixels if needed.
- Performance on large views
  - Clamp export size to ~1200×1200; throttle concurrent requests; cancel on new draw.

---

### Open Questions (minor)

1. Pixel origin and y‑axis direction from the API output: default assumption is top‑left origin, y down; we will auto‑detect via calibration if different.
2. For `labels`, defaulting to `[1]` (foreground) is acceptable for bbox mode—confirm we should always send `[1]` for MVP.
3. Do we want a small toast reminding users that results are not saved in MVP?

Given current answers: (1) will be auto‑detected; (2) send `[1]`; (3) default yes unless you prefer no toast.

---

### Rollout Steps

1. Add `AISegmentationControl` and `useAISegmentation` (generic, reusable) under `src/components` and/or `src/hooks`.
2. Wire into `DatasetDetailsMap` using existing `mapRef` and `layerRefs` (ortho layer).
3. Implement ortho‑only capture; add offscreen map fallback for robustness.
4. Build request payload with bbox + image; default `labels=[1]`.
5. Convert returned pixel polygons to map features and render on `aiResultLayer`.
6. Add clear/reset logic; ensure cleanup on unmount.
7. Basic QA: alignment check, performance, error paths.

---

### Testing Checklist

- Draw bbox at center and corners of the view; verify alignment of returned polygons.
- Change zoom before drawing; ensure pixel→map conversion still aligns.
- Stress test warm calls: back‑to‑back draws (expect fast responses).
- Turn basemap on/off (if visible during capture) and verify CORS safety; fallback to ortho‑only path if needed.

---

### Success Metrics

- User can draw a bbox and see aligned polygons within ≤2s (warm) end‑to‑end.
- Alignment visually correct within ≤1 pixel at 1200×1200 capture.
- No blocking UI; map remains interactive during processing.

---

### Future Work (post‑MVP)

- Save to Supabase `labels` with typed schema and audit trail.
- Point prompts and multi‑prompt refinement.
- On‑map polygon editing/refinement and acceptance flow.
- Batch mode (multiple bboxes) and union/merge utilities.
- Quality filters and class selection.

---

### Notes on Questions 3 and 10

- Q3 (pixel origin): Because we submit the exact map capture used for bbox coordinates, the returned pixels are in the same image space; orientation mismatches are solved by a one‑time calibration (translate/flip) if needed.
- Q10 (hiding basemap): Not strictly necessary if all visible sources are CORS‑safe; however, to avoid tainted canvas and to keep the model focused on ortho pixels, we’ll implement an ortho‑only capture path (either by temporarily hiding basemap or via an offscreen map). This gives predictable, robust behavior across environments.
