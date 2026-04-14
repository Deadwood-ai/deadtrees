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

export const createOpenFreeMapLibertyLayerGroup = () => {
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

export const createWaybackSource = (releaseNum: number) =>
  new XYZ({
    url: getWaybackTileUrl(releaseNum),
    attributions: WAYBACK_ATTRIBUTION,
    maxZoom: 19,
    crossOrigin: "anonymous",
  });

export const createWaybackTileLayer = (releaseNum: number) =>
  new TileLayer({
    preload: 0,
    source: createWaybackSource(releaseNum),
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
