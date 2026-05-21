import TileLayer from "ol/layer/Tile";
import { XYZ } from "ol/source";

export const PRIWA_OSM_TILE_URL =
  "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const PRIWA_OSM_ATTRIBUTION = "© OpenStreetMap contributors";
export const PRIWA_OSM_MAX_ZOOM = 19;

export const createPriwaOsmLayer = () =>
  new TileLayer({
    preload: 1,
    visible: false,
    source: new XYZ({
      url: PRIWA_OSM_TILE_URL,
      attributions: PRIWA_OSM_ATTRIBUTION,
      maxZoom: PRIWA_OSM_MAX_ZOOM,
      crossOrigin: "anonymous",
    }),
  });
