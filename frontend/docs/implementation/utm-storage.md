# UTM Storage for Reference Patches

## Overview

Reference patches are stored in **UTM projection** (not Web Mercator) for accurate ground measurements. Each patch has an associated `utm_zone` field that specifies its projection (e.g., "32N", "33S").

## Why UTM?

- **No distortion**: UTM provides true ground measurements in meters
- **Consistent dimensions**: A 204.8m × 204.8m patch is exactly that size on the ground
- **No latitude correction needed**: Unlike Web Mercator, no geodesic correction is required

## Database Schema

```sql
reference_patches:
  - geometry: JSONB (stored in UTM coordinates)
  - utm_zone: VARCHAR(5) (e.g., "32N", "33S")
  - epsg_code: INTEGER (e.g., 32632 for 32N, 32733 for 33S)
  - bbox_minx, bbox_miny, bbox_maxx, bbox_maxy: DOUBLE PRECISION (in UTM coordinates)
```

## Frontend Pattern

### 1. Creating Patches

```tsx
import { getUtmZoneFromWebMercator, webMercatorToUtm, createUtmSquare, getTargetGroundSize } from "../../utils/utm";

// Map center is in Web Mercator
const [centerWebMercX, centerWebMercY] = mapCenterCoords;

// Calculate UTM zone and transform
const utmZone = getUtmZoneFromWebMercator(centerWebMercX, centerWebMercY);
const epsgCode = getUtmEpsgCode(utmZone); // Calculate EPSG code once
const [centerUtmX, centerUtmY] = webMercatorToUtm(centerWebMercX, centerWebMercY, utmZone);

// Create exact square in UTM
const targetGroundSize = getTargetGroundSize(20); // 204.8m for 20cm resolution
const patchGeometry = createUtmSquare(centerUtmX, centerUtmY, targetGroundSize);

// Save to database
await createPatch({
  geometry: patchGeometry, // UTM coordinates
  utm_zone: utmZone,
  epsg_code: epsgCode, // Stored for reuse (no recalculation needed!)
  bbox_minx: patchGeometry.coordinates[0][0][0], // UTM coordinates
  // ...
});
```

### 2. Displaying Patches on Map

```tsx
import { transformPolygonUtmToWebMercator } from "../../utils/utm";

// Transform UTM geometry to Web Mercator for display
const webMercatorGeometry = transformPolygonUtmToWebMercator(patch.geometry, patch.utm_zone);

// Create OpenLayers feature
const feature = new Feature({
  geometry: geoJsonFormatter.readGeometry(webMercatorGeometry, {
    dataProjection: "EPSG:3857",
    featureProjection: "EPSG:3857",
  }),
});
feature.set("utmZone", patch.utm_zone); // Store for later use
```

### 3. Updating Patches (Drag/Edit)

```tsx
import { transformPolygonWebMercatorToUtm } from "../../utils/utm";

// User drags patch on map (in Web Mercator)
translate.on("translateend", (evt) => {
  const feature = evt.features?.item(0);
  const utmZone = feature.get("utmZone");

  // Get updated Web Mercator geometry
  const updatedWebMercatorGeom = geoJsonFormatter.writeGeometryObject(feature.getGeometry());

  // Transform back to UTM for storage
  const updatedUtmGeom = transformPolygonWebMercatorToUtm(updatedWebMercatorGeom, utmZone);

  // Save to database
  updatePatchGeometry({
    patchId,
    geometry: updatedUtmGeom, // UTM coordinates
    bbox: extractBbox(updatedUtmGeom), // UTM coordinates
  });
});
```

### 4. Nested Patch Generation

```tsx
// Parent patch is in UTM
const parentGeom = parentPatch.geometry; // Already in UTM
const [minx, miny] = parentGeom.coordinates[0][0];
const [maxx, maxy] = parentGeom.coordinates[0][2];

// Simple quadrant division (no distortion!)
const centerX = (minx + maxx) / 2;
const centerY = (miny + maxy) / 2;

// Create child patches in same UTM zone
const childGeometry = createUtmSquare(centerX, centerY, targetGroundSize);
await createPatch({
  geometry: childGeometry,
  utm_zone: parentPatch.utm_zone, // Inherit parent's UTM zone
  epsg_code: parentPatch.epsg_code, // Inherit parent's EPSG code
  // ...
});
```

### 5. Clipping Predictions to Patch

```tsx
import { clipGeometriesInBatches } from "../../hooks/useReferenceGeometriesBatch";

// Bbox is in UTM coordinates
const bbox = {
  minx: patch.bbox_minx,
  miny: patch.bbox_miny,
  maxx: patch.bbox_maxx,
  maxy: patch.bbox_maxy,
};

// Backend RPC transforms predictions (WGS84) to UTM for clipping
const clippedGeoms = await clipGeometriesInBatches({
  labelId,
  geometryTable: "v2_deadwood_geometries",
  bbox, // UTM coordinates
  epsgCode: patch.epsg_code, // Use pre-calculated EPSG code
});
```

## Backend Pattern

### Database RPC Functions

```sql
-- Accept UTM bbox and pre-calculated EPSG code
CREATE OR REPLACE FUNCTION get_clipped_geometries_batch(
  p_bbox_minx double precision,
  p_bbox_miny double precision,
  p_bbox_maxx double precision,
  p_bbox_maxy double precision,
  p_epsg_code integer,  -- Pre-calculated (e.g., 32632)
  ...
) RETURNS TABLE(geometry jsonb, total_count bigint) AS $$
BEGIN
  -- Create bbox in UTM using provided EPSG code, transform to WGS84 for clipping
  bbox_geom := ST_Transform(
    ST_MakeEnvelope(p_bbox_minx, p_bbox_miny, p_bbox_maxx, p_bbox_maxy, p_epsg_code),
    4326
  );

  -- Clip and return geometries
  ...
END;
$$;
```

## UTM Zone Calculation

```tsx
// From Web Mercator coordinates
const utmZone = getUtmZoneFromWebMercator(x, y);

// From WGS84 coordinates
const zone = Math.floor((lon + 180) / 6) + 1;
const hemisphere = lat >= 0 ? "N" : "S";
const utmZone = `${zone}${hemisphere}`;
```

## EPSG Code Mapping

- **Northern Hemisphere**: EPSG:326XX (e.g., Zone 32N = EPSG:32632)
- **Southern Hemisphere**: EPSG:327XX (e.g., Zone 33S = EPSG:32733)

## Key Utilities

### `src/utils/utm.ts`

- `calculateUtmZone(lon, lat)`: Calculate zone from WGS84 coords
- `getUtmZoneFromWebMercator(x, y)`: Calculate zone from Web Mercator
- `getUtmEpsgCode(utmZone)`: Convert zone string to EPSG code
- `webMercatorToUtm(x, y, utmZone)`: Transform coords
- `utmToWebMercator(x, y, utmZone)`: Transform coords
- `createUtmSquare(centerX, centerY, sizeMeters)`: Create exact square
- `transformPolygonUtmToWebMercator(polygon, utmZone)`: Transform polygon
- `transformPolygonWebMercatorToUtm(polygon, utmZone)`: Transform polygon

## Important Notes

1. **Always store in UTM**: Database stores geometry in UTM coordinates
2. **Always display in Web Mercator**: OpenLayers map uses EPSG:3857
3. **Transform at boundaries**: Convert when reading from DB (UTM → Web Mercator) and writing to DB (Web Mercator → UTM)
4. **Inherit UTM zone**: Child patches always use parent's UTM zone
5. **No geodesic correction**: UTM is accurate - no need for latitude-based scaling

## Migration

Existing patches in Web Mercator will have `utm_zone = NULL`. Handle gracefully:

```tsx
if (!patch.utm_zone) {
  console.warn("Legacy patch without UTM zone, skipping");
  return;
}
```

## Testing

Use the measuring tool in ReferencePatchMap to verify patch dimensions:

- 20cm patches should be **204.8m × 204.8m**
- 10cm patches should be **102.4m × 102.4m**
- 5cm patches should be **51.2m × 51.2m**
