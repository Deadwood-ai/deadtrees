# Short-term Traffic Protection Plan (2–3 weeks)

Goal: Stay within Mapbox free tiers with minimal frontend edits while keeping high zoom for drone imagery. This plan swaps streets to free OpenStreetMap tiles, keeps Mapbox only for satellite, and reduces unnecessary tile churn without architectural changes.

## Constraints & Principles

- Keep all existing COG (GeoTIFF) and vector tiles functionality unchanged.
- High map zoom must remain available for drone imagery (view zoom up to 22–23). Basemap OSM tiles top out at z=19; allow upscaling beyond 19 instead of requesting out‑of‑range tiles.
- Zero backend changes. Low-risk, localized edits only.
- Respect OSM tile usage policy (attribution, caching, no “no-cache”).

References:

- OSM policy: https://operations.osmfoundation.org/policies/tiles/
- Mapbox pricing context (Static vs Raster Tiles API free tiers): `Static: 200k/mo`, `Raster: 750k/mo` (maps pricing page)

## High-level strategy

1. Switch all “streets” basemaps to free OSM (`tile.openstreetmap.org`).
2. Keep Mapbox only for satellite (existing v4 raster endpoint). This uses the larger Raster Tiles free tier (750k/month).
3. Gate satellite to higher zoom (default streets; allow satellite ≥ 14). Optional confirmation dialog for satellite.
4. Cut needless requests: no preloading, no updateWhileAnimating/Interacting on basemap layers, lazy-init maps below the fold.

## Concrete changes (file-by-file)

### 1) Dataset list/browse map

File: `src/components/DatasetMap/DatasetMap.tsx`

- Replace Mapbox streets source with OSM for basemap init.
- Keep view zoom limits unchanged (for overlays). Add basemap `preload: 0`.

```ts
// Before
const basemapLayer = new TileLayer({
  source: new XYZ({
    url: `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/{z}/{x}/{y}?access_token=${import.meta.env.VITE_MAPBOX_ACCESS_TOKEN}`,
    attributions: "© Mapbox © OpenStreetMap contributors",
  }),
});

// After
const basemapLayer = new TileLayer({
  preload: 0,
  // optional: updateWhileAnimating: false, updateWhileInteracting: false,
  source: new XYZ({
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attributions: "© OpenStreetMap contributors",
    maxZoom: 19, // prevent 404s; OL will upscale beyond 19 when view zoom > 19
    tileSize: 256,
  }),
});
```

### 2) Deadwood visualization map

File: `src/components/DeadwoodMap/DeadtreesMap.tsx`

- When `DeadwoodMapStyle !== "satellite-streets-v12"`, use OSM; otherwise keep existing Mapbox satellite raster endpoint.
- Add basemap `preload: 0`. Keep view zoom limits (drone imagery layers remain fully zoomable).
- Add a simple guard: only allow switching to satellite when `view.getZoom() >= 14`; otherwise keep streets and show a brief info toast.

```ts
// Streets → OSM
url: DeadwoodMapStyle === "satellite-streets-v12"
  ? `https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}.jpg?access_token=${import.meta.env.VITE_MAPBOX_ACCESS_TOKEN}`
  : "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
attributions: DeadwoodMapStyle === "satellite-streets-v12"
  ? "© Mapbox © OpenStreetMap contributors"
  : "© OpenStreetMap contributors",
```

Satellite zoom gate (example logic in the place where style is set):

```ts
if (nextStyle === "satellite-streets-v12") {
  const zoom = map.getView().getZoom();
  if (!zoom || zoom < 14) {
    // message.info("Satellite loads at zoom 14+ to save bandwidth.");
    return; // keep streets
  }
}
setDeadwoodMapStyle(nextStyle);
```

### 3) Dataset details map

File: `src/components/DatasetDetailsMap/DatasetDetailsMap.tsx`

- Same switch as above: OSM for streets; keep Mapbox v4 raster for satellite.
- Keep `view` maxZoom high (22–23). Set OSM `maxZoom: 19`, `tileSize: 256`, `preload: 0`.

```ts
url: mapStyle === "satellite-streets-v12"
  ? `https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}.jpg?access_token=${import.meta.env.VITE_MAPBOX_ACCESS_TOKEN}`
  : "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
attributions: mapStyle === "satellite-streets-v12"
  ? "© Mapbox © OpenStreetMap contributors"
  : "© OpenStreetMap contributors",
```

### 4) Dataset audit map

File: `src/components/DatasetAudit/DatasetAuditMap.tsx`

- Same as details map: OSM for streets; Mapbox v4 raster for satellite; `preload: 0`; OSM `maxZoom: 19`.

```ts
url: mapStyle === "satellite-streets-v12"
  ? `https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}.jpg?access_token=${import.meta.env.VITE_MAPBOX_ACCESS_TOKEN}`
  : "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
attributions: mapStyle === "satellite-streets-v12"
  ? "© Mapbox © OpenStreetMap contributors"
  : "© OpenStreetMap contributors",
```

### 5) Lazy initialization (optional but recommended)

- Wrap each map container with an `IntersectionObserver` to instantiate the map only when visible.
- This is a reusable `<LazyMap>` wrapper and does not change any map logic.

```ts
// Pseudocode
const LazyMap: React.FC<{ children: (visible: boolean) => React.ReactNode }> = ({ children }) => {
  /* IO hookup */
};
```

### 6) Attribution correctness

- Streets (OSM): `© OpenStreetMap contributors` (link to OSM copyright page if preferred).
- Satellite (Mapbox): `© Mapbox © OpenStreetMap contributors`.
- Make sure attribution updates when switching styles.

## Zoom behavior notes (important)

- Keep the OpenLayers `View` `maxZoom` high (e.g., 22–23) so drone imagery and vector layers continue to display with full detail.
- Set only the OSM tile source `maxZoom` to 19; this prevents 404s while allowing OL to upscale z19 tiles when users zoom further in. The overlays still render at native resolution.

## Risk & Rollout

- Low risk: single-line changes to basemap URLs/attributions and small guards.
- Rollout order: DatasetMap → DeadtreesMap → DatasetDetailsMap → DatasetAuditMap.
- Monitoring: track Mapbox dashboard for Raster/Static tiles after deploy; expect Static → ~0, Raster ↓ substantially.

## Revert plan

- If any issue appears, revert the basemap URL back to the previous Mapbox streets URL in the affected component.

## Next steps (post 2–3 weeks)

- Migrate satellite to Mapbox GL JS with map‑load billing (per long-term plan) while keeping OSM as default streets.
