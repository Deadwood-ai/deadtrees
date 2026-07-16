import Collection from "ol/Collection";
import { Attribution, Zoom } from "ol/control";
import type Control from "ol/control/Control";
import LayerGroup from "ol/layer/Group";
import TileLayer from "ol/layer/Tile";
import { XYZ } from "ol/source";
import Stroke from "ol/style/Stroke";
import { apply } from "ol-mapbox-style";

import { getWaybackTileUrl } from "./waybackVersions";

export const OPENFREEMAP_LIBERTY_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
export const OPENFREEMAP_ATTRIBUTION = "OpenFreeMap © OpenMapTiles Data from OpenStreetMap";
export const OPENFREEMAP_MAX_ZOOM = 14;
export const OPENSTREETMAP_ATTRIBUTION = "© OpenStreetMap contributors";
export const WAYBACK_ATTRIBUTION = "Imagery © Esri World Imagery Wayback, Maxar, Earthstar Geographics";

type StrokeWithOffsetCompat = Stroke & {
  dtOffset_?: number;
  getOffset?: () => number | undefined;
  setOffset?: (offset: number | undefined) => void;
};

const ensureOpenLayersStrokeOffsetCompatibility = () => {
  const strokePrototype = Stroke.prototype as StrokeWithOffsetCompat;

  if (typeof strokePrototype.setOffset !== "function") {
    strokePrototype.setOffset = function (offset) {
      this.dtOffset_ = offset;
    };
  }

  if (typeof strokePrototype.getOffset !== "function") {
    strokePrototype.getOffset = function () {
      return this.dtOffset_;
    };
  }
};

ensureOpenLayersStrokeOffsetCompatibility();

export const applyOpenFreeMapLibertyStyle = (target: Parameters<typeof apply>[0]) =>
  apply(target, OPENFREEMAP_LIBERTY_STYLE_URL);

export const createStandardMapControls = ({
  includeZoom = true,
  includeAttribution = false,
  attributionCollapsed = true,
}: {
  includeZoom?: boolean;
  includeAttribution?: boolean;
  attributionCollapsed?: boolean;
} = {}) => {
  const controls: Control[] = [];

  if (includeZoom) {
    controls.push(
      new Zoom({
        className: "dt-map-zoom-control",
      }),
    );
  }

  if (includeAttribution) {
    controls.push(
      new Attribution({
        className: "dt-map-attribution-control",
        collapsible: true,
        collapsed: attributionCollapsed,
      }),
    );
  }

  return new Collection(controls);
};

const createOpenFreeMapLibertyLayerGroup = () => {
  const libertyLayerGroup = new LayerGroup();
  const streetsFallbackLayer = createOpenStreetMapFallbackLayer();
  const group = new LayerGroup({
    layers: [libertyLayerGroup, streetsFallbackLayer],
  });

  void applyOpenFreeMapLibertyStyle(libertyLayerGroup).catch((error) => {
    console.error("Failed to load OpenFreeMap Liberty basemap", error);
    streetsFallbackLayer.setMinZoom(0);
  });

  return group;
};

// ol-mapbox-style's apply() permanently registers every layer it styles in a
// module-level cache (styleFunctionArgs in stylefunction.js) that is never
// cleaned up and is not reachable through the package's public API. Each call
// therefore pins the created basemap layer — together with its parsed vector
// tiles, rendered tile canvases and, via the layer's map back-reference,
// often the whole disposed map — for the lifetime of the page (~390MB RSS per
// dataset-archive navigation cycle, measured on production).
//
// Instead of creating a fresh Liberty group per map mount, maps borrow one
// from this pool and hand it back on unmount. apply() then runs once per
// pooled group ever, so the olms cache stays bounded at the maximum number of
// simultaneously mounted maps (in practice: 1). Reuse also keeps the style
// and basemap tile caches warm across navigations.
const libertyBasemapPool: LayerGroup[] = [];

/**
 * Borrow a Liberty basemap layer group. Callers MUST detach it from their map
 * and return it via releaseLibertyBasemapGroup() in their cleanup — disposing
 * it or its sources would break the next borrower.
 */
export const acquireLibertyBasemapGroup = (): LayerGroup => {
  const group = libertyBasemapPool.pop() ?? createOpenFreeMapLibertyLayerGroup();
  // Reset state a previous borrower may have left behind.
  group.setVisible(true);
  return group;
};

/** Return a borrowed Liberty basemap group to the pool (idempotent). */
export const releaseLibertyBasemapGroup = (group: LayerGroup): void => {
  if (!libertyBasemapPool.includes(group)) {
    libertyBasemapPool.push(group);
  }
};

/**
 * Default Wayback release used before any location-specific discovery runs.
 *
 * IMPORTANT: ESRI release numbers are NOT ordered by time (e.g. 31144 is the
 * 2014-06-11 release while 32246 is 2026-06-30). Pick the newest entry from
 * `getWaybackItems()` when bumping this; keep the date in sync — it lets the
 * imagery picker resolve which candidate's image the default actually shows.
 */
export const DEFAULT_WAYBACK_RELEASE = 32246; // World Imagery (Wayback 2026-06-30)
export const DEFAULT_WAYBACK_RELEASE_DATETIME = Date.UTC(2026, 5, 30);

export const createWaybackSource = (releaseNum: number) =>
  new XYZ({
    url: getWaybackTileUrl(releaseNum),
    attributions: WAYBACK_ATTRIBUTION,
    maxZoom: 19,
    crossOrigin: "anonymous",
  });

// Reuse one XYZ source per Wayback release so switching releases (or toggling
// the basemap style) keeps each release's OpenLayers tile cache alive instead
// of re-downloading the whole viewport. Bounded LRU so long browsing sessions
// don't pin unlimited tile caches in memory.
const waybackSourceCache = new Map<number, XYZ>();
const WAYBACK_SOURCE_CACHE_MAX = 12;

export const getCachedWaybackSource = (releaseNum: number): XYZ => {
  const cached = waybackSourceCache.get(releaseNum);
  if (cached) {
    // Re-insert to mark as most recently used
    waybackSourceCache.delete(releaseNum);
    waybackSourceCache.set(releaseNum, cached);
    return cached;
  }
  const source = createWaybackSource(releaseNum);
  waybackSourceCache.set(releaseNum, source);
  if (waybackSourceCache.size > WAYBACK_SOURCE_CACHE_MAX) {
    const oldest = waybackSourceCache.keys().next().value;
    if (oldest !== undefined) waybackSourceCache.delete(oldest);
  }
  return source;
};

export const createWaybackTileLayer = (releaseNum: number) =>
  new TileLayer({
    preload: 0,
    source: getCachedWaybackSource(releaseNum),
  });

export const createOpenStreetMapFallbackLayer = () =>
  new TileLayer({
    preload: 0,
    minZoom: OPENFREEMAP_MAX_ZOOM + 1,
    source: new XYZ({
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      attributions: OPENSTREETMAP_ATTRIBUTION,
      maxZoom: 19,
      crossOrigin: "anonymous",
    }),
  });
