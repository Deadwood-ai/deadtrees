/* global location, document, window, performance, PerformanceObserver, URLSearchParams */
// Standalone offline renderer benchmark, built only by build-streets-replay.mjs.
// It replays the building layer from two fixed public OpenFreeMap tiles at the
// dataset 8272 camera. It measures rendering, not metadata/COG/backend latency.
import Map from "ol/Map.js";
import View from "ol/View.js";
import Feature from "ol/Feature.js";
import MVT from "ol/format/MVT.js";
import VectorTileLayer from "ol/layer/VectorTile.js";
import VectorTileSource from "ol/source/VectorTile.js";
import Style from "ol/style/Style.js";
import Fill from "ol/style/Fill.js";
import Stroke from "ol/style/Stroke.js";
const full = new URLSearchParams(location.search).get("mode") === "full";
const start = performance.now();
const tasks = [];
new PerformanceObserver((list) =>
  tasks.push(
    ...list.getEntries().map((x) => ({ start: x.startTime, ms: x.duration })),
  ),
).observe({ type: "longtask", buffered: true });
const source = new VectorTileSource({
  format: new MVT({
    layerName: "mvt:layer",
    ...(full ? { featureClass: Feature } : {}),
  }),
  minZoom: 14,
  maxZoom: 14,
  tileUrlFunction: ([z, x, y]) =>
    z === 14 && y === 7076 && (x === 12303 || x === 12304)
      ? `/${z}-${x}-${y}.pbf`
      : undefined,
});
const style = new Style({
  fill: new Fill({ color: "rgba(155,153,151,0.8)" }),
  stroke: new Stroke({ color: "rgba(155,153,151,0.8)", width: 0.5 }),
});
const map = new Map({
  target: "map",
  controls: [],
  layers: [
    new VectorTileLayer({
      source,
      style: (feature) =>
        feature.get("mvt:layer") === "building" ? style : undefined,
    }),
  ],
  view: new View({
    center: [10057555.517877884, 2728457.943153508],
    zoom: 16.906890595609656,
  }),
});
let firstComplete;
map.on("rendercomplete", () => {
  firstComplete ??= performance.now() - start;
  document.querySelector("#summary").textContent =
    `Local fixed Streets tiles · ${full ? "separate polygons" : "original flat rings"} · complete ${Math.round(firstComplete)} ms`;
});
window.__replay = {
  map,
  report: () => ({
    mode: full ? "full" : "original",
    viewport: [window.innerWidth, window.innerHeight, window.devicePixelRatio],
    complete: firstComplete,
    tasks,
    maxTask: Math.max(0, ...tasks.map((x) => x.ms)),
    blocking: tasks.reduce((sum, x) => sum + Math.max(0, x.ms - 50), 0),
  }),
};
