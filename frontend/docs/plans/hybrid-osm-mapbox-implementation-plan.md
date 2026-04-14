# Hybrid OSM/Mapbox Map Architecture Implementation Plan

## Overview

This document outlines the implementation plan for refactoring the DeadTrees.earth mapping architecture to reduce Mapbox API costs by 70–90% while maintaining all existing functionality. The solution implements a hybrid approach using free OpenStreetMap tiles as the default with Mapbox GL JS only for satellite imagery.

## Current State Analysis

### Existing Architecture Problems

- High API costs: Mapbox tiles used across styles with tile-request billing
- No tile caching strategy: redundant API requests on pan/zoom
- Component duplication: multiple map components with similar setup logic
- Inefficient billing: charged per tile instead of per map load

### Current Map Components

1. `src/components/DatasetMap/DatasetMap.tsx`

   - Overview/browse map with dataset extents and markers
   - Currently uses Mapbox streets raster tiles via XYZ 512px

2. `src/components/DeadwoodMap/DeadtreesMap.tsx`

   - Visualization map with multiple GeoTIFF layers
   - Style toggle between streets and satellite

3. `src/components/DatasetDetailsMap/DatasetDetailsMap.tsx`

   - Detailed dataset view with COG/WebGL and vector overlays from PostGIS

4. `src/components/DatasetAudit/DatasetAuditMap.tsx`
   - Editing/AOI/drawing interactions and orthophoto overlay

## Target Architecture

### Cost Optimization Strategy

- Streets/default view: Free OpenStreetMap official tiles
  - URL: `https://tile.openstreetmap.org/{z}/{x}/{y}.png`
  - Attribution: `© OpenStreetMap contributors`
- Satellite view: Mapbox GL JS (map-load billing) for raster satellite imagery
  - Style: `mapbox://styles/mapbox/satellite-streets-v12?optimize=true`
  - Attribution: `© Mapbox © OpenStreetMap contributors`
- Preserve existing COG (GeoTIFF) and PostGIS vector tile layers
- Centralized, modular configuration with reusable base map component

### Technical Benefits

- Significant cost reduction (use free tiles for most usage)
- Proper HTTP caching; fewer redundant requests
- Shared base code and consistent lifecycle across maps
- Flexible provider switching and future extension

## Implementation Plan

### Phase 1: Foundation and Research

#### 1.1 OpenStreetMap integration and policy

- Tile usage policy requirements: set valid User-Agent/Referer, enable caching, do not send no-cache headers
- Reference: [OSM Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/)
- Required attribution: `© OpenStreetMap contributors`

#### 1.2 Mapbox GL JS hybrid integration

- Use Mapbox GL JS as a rendered layer inside OpenLayers for satellite imagery
- Keep Mapbox GL map non-interactive and sync OL view → Mapbox view
- Reference pattern: OpenLayers example for Mapbox-gl layer: [Mapbox-gl Layer](https://openlayers.org/en/latest/examples/mapbox-layer.html)

#### 1.3 Tile source configuration design

Define a typed configuration set for basemaps, decoupled from components.

```ts
interface TileSourceConfig {
  id: string;
  name: string;
  type: "raster" | "mapbox-gl";
  url?: string;
  style?: string;
  attribution: string;
  maxZoom: number;
  tileSize: number;
}

const TILE_SOURCES: Record<string, TileSourceConfig> = {
  osm: {
    id: "osm",
    name: "OpenStreetMap",
    type: "raster",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "© OpenStreetMap contributors",
    maxZoom: 19,
    tileSize: 256,
  },
  mapbox_satellite: {
    id: "mapbox_satellite",
    name: "Satellite",
    type: "mapbox-gl",
    style: "mapbox://styles/mapbox/satellite-streets-v12?optimize=true",
    attribution: "© Mapbox © OpenStreetMap contributors",
    maxZoom: 22,
    tileSize: 512,
  },
};
```

### Phase 2: Core Map Architecture

#### 2.1 Base map props and viewport types

```ts
interface MapViewport {
  center: [number, number];
  zoom: number;
  bounds?: [number, number, number, number];
}

interface BaseMapProps {
  container: React.RefObject<HTMLDivElement>;
  center: [number, number];
  zoom: number;
  style: "streets" | "satellite";
  onViewportChange?: (viewport: MapViewport) => void;
  onStyleChange?: (style: "streets" | "satellite") => void;
  children?: React.ReactNode;
}
```

#### 2.2 Tile source factory (OSM + Mapbox GL)

```ts
import XYZ from "ol/source/XYZ";
import TileLayer from "ol/layer/Tile";

export function createOSMLayer(): TileLayer<XYZ> {
  const source = new XYZ({
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attributions: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
    tileSize: 256,
  });

  // Respect server cache; do not add no-cache headers
  // Browser fetches will include Referer automatically

  return new TileLayer({ source });
}
```

For Mapbox satellite, implement an OL layer that renders a Mapbox GL JS canvas and synchronizes the view (pattern based on OL example).

#### 2.3 Style switching manager

```ts
enum MapStyle {
  STREETS = "streets",
  SATELLITE = "satellite",
}

class MapStyleManager {
  switchBase(map: Map, next: MapStyle) {
    // Remove current base
    // Add OSM TileLayer for streets OR Mapbox GL rendered layer for satellite
    // Update attribution overlay accordingly
  }
}
```

#### 2.4 Shared init/cleanup utilities

```ts
interface MapInitConfig {
  target: HTMLElement;
  center: [number, number];
  zoom: number;
  style: "streets" | "satellite";
  extraLayers?: Layer[];
}

class MapUtils {
  static init(config: MapInitConfig): Map {
    // Create OL map, add base according to style, attach listeners
  }

  static dispose(map: Map): void {
    // Detach listeners, remove layers/sources, clear target
  }
}
```

### Phase 3: OpenStreetMap Integration

#### 3.1 OSM tile layer with attribution and compliance

```ts
import XYZ from "ol/source/XYZ";
import TileLayer from "ol/layer/Tile";

export const createOSMLayerWithFallback = (): TileLayer<XYZ> => {
  const source = new XYZ({
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attributions: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  });

  source.on("tileloaderror", (e) => {
    // Optional: log, show banner, or switch to a backup OSM-compatible provider
    // Keep minimal to avoid violating OSM policy
    console.warn("OSM tile failed:", e);
  });

  return new TileLayer({ source });
};
```

Notes:

- Do not send no-cache headers; allow server caching per OSM policy
- Always show attribution visibly
- Use browser default Referer; ensure a meaningful User-Agent on server-side requests only (not applicable for browser tile loads)

### Phase 4: Mapbox Hybrid Integration (Satellite Only)

#### 4.1 Render Mapbox GL JS inside OL

Pattern (summarized):

- Instantiate a Mapbox GL map with `interactive: false`
- In the OL layer `render(frameState)`, sync center/zoom/bearing from OL view to Mapbox
- Force synchronous redraw using internal frame control (per OL example note)
- Return Mapbox canvas for composition

Reference example: [OpenLayers Mapbox-gl Layer](https://openlayers.org/en/latest/examples/mapbox-layer.html)

```ts
import mapboxgl from "mapbox-gl";
import Layer from "ol/layer/Layer";
import Source from "ol/source/Source";
import { toLonLat } from "ol/proj";

export class MapboxGLLayer extends Layer {
  private mbMap: mapboxgl.Map;

  constructor(style: string, accessToken: string) {
    super({
      source: new Source({
        attributions: ["© Mapbox", "© OpenStreetMap contributors"],
      }),
    });

    mapboxgl.accessToken = accessToken;
    this.mbMap = new mapboxgl.Map({
      style,
      container: document.createElement("div"),
      interactive: false,
      attributionControl: false,
      boxZoom: false,
      doubleClickZoom: false,
      dragPan: false,
      dragRotate: false,
      keyboard: false,
      scrollZoom: false,
      touchZoomRotate: false,
    });
  }

  render(frameState: any) {
    const canvas = this.mbMap.getCanvas();
    const { center, rotation, zoom } = frameState.viewState;

    this.mbMap.jumpTo({
      center: toLonLat(center),
      zoom: zoom - 1,
      bearing: (-rotation * 180) / Math.PI,
      animate: false,
    });

    // Force synchronous redraw; may break with future Mapbox versions
    if ((this.mbMap as any)._frame) {
      (this.mbMap as any)._frame.cancel();
      (this.mbMap as any)._frame = null;
    }
    (this.mbMap as any)._render();

    return canvas;
  }
}
```

#### 4.2 Satellite style and billing

- Use Mapbox style `mapbox://styles/mapbox/satellite-streets-v12?optimize=true`
- This is billed by map loads, not tile requests, when Mapbox GL JS initializes once per map instance

### Phase 5: Reusable Components

#### 5.1 BaseMapComponent

```tsx
export const BaseMapComponent: React.FC<BaseMapProps> = ({
  style,
  center,
  zoom,
  onViewportChange,
  onStyleChange,
  children,
}) => {
  const mapRef = useRef<Map | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Build base layer
    const base =
      style === "streets"
        ? createOSMLayer()
        : new MapboxGLLayer(
            "mapbox://styles/mapbox/satellite-streets-v12?optimize=true",
            import.meta.env.VITE_MAPBOX_ACCESS_TOKEN,
          );

    const map = new Map({
      target: containerRef.current,
      layers: [base],
      view: new View({ center, zoom }),
      controls: [],
    });

    mapRef.current = map;

    map.on("moveend", () => {
      onViewportChange?.({
        center: map.getView().getCenter() as [number, number],
        zoom: map.getView().getZoom() as number,
      });
    });

    return () => {
      MapUtils.dispose(map);
    };
  }, [style]);

  return (
    <div className="map-root">
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      {children}
    </div>
  );
};
```

#### 5.2 MapContainer wrapper (style switcher + attribution)

```tsx
const MapAttribution: React.FC<{ style: "streets" | "satellite" }> = ({ style }) => (
  <div
    className="map-attribution"
    dangerouslySetInnerHTML={{
      __html:
        style === "streets"
          ? '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          : '© <a href="https://www.mapbox.com/">Mapbox</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }}
  />
);
```

### Phases 6–9: Component Migration

#### Migration template (example: DatasetMap)

Before (simplified): requests Mapbox streets raster tiles directly

```ts
const basemapLayer = new TileLayer({
  source: new XYZ({
    url: `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/{z}/{x}/{y}?access_token=${token}`,
  }),
});
```

After: use `BaseMapComponent` with `style="streets"` (OSM) by default; retain vector layers

```tsx
const DatasetMap = ({ data }) => {
  const [viewport, setViewport] = useState({ center: [0, 0] as [number, number], zoom: 2 });

  return (
    <BaseMapComponent style="streets" center={viewport.center} zoom={viewport.zoom} onViewportChange={setViewport}>
      {/* Existing vector overlays */}
      <DatasetOverlays data={data} />
    </BaseMapComponent>
  );
};
```

Apply the same pattern to `DeadtreesMap`, `DatasetDetailsMap`, and `DatasetAuditMap`, preserving COG and vector tile integrations.

### Phase 10: Configuration and UI

- Add map configuration to `Settings` with defaults:
  - Default style: streets (OSM)
  - OSM tile URL and attribution
  - Mapbox satellite style and attribution
- Update any style switcher UI to toggle only between `streets` (OSM) and `satellite` (Mapbox)

### Phase 11: Performance & Optimization

- Respect OSM caching; avoid sending `Cache-Control: no-cache`
- Use `minZoom`/`maxZoom` constraints on overlays to reduce tile churn
- Lazy-load maps below the fold via `IntersectionObserver`
- Consider service worker cache for tiles (optional; ensure policy compliance)

### Phase 12: Documentation & Rollout

- Document the new base map API and usage patterns
- Provide migration notes for developers working on map features
- Roll out component by component; monitor cost and performance

## Cost Impact

- Before: Mapbox raster tiles for all views (tile-request billing); high costs
- After: OSM for streets (free), Mapbox GL JS only for satellite (map-load billing)
- Expected reduction: 70–90% monthly Mapbox costs

## Compliance & Attribution

- OSM policy: [Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/)
- Required visible attribution:
  - Streets: `© OpenStreetMap contributors`
  - Satellite: `© Mapbox © OpenStreetMap contributors`

## Success Metrics

- Mapbox API usage reduced by ≥70%
- No functional regressions across map components
- Tile cache hit rate ≥80% for repeated interactions
- Smooth style switching and consistent attributions
