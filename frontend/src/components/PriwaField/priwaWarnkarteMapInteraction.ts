import type Map from "ol/Map";
import Overlay from "ol/Overlay";
import { unByKey } from "ol/Observable";

import type { createPriwaWarnkarteLayer } from "./createPriwaWarnkarteLayer";

export const formatPriwaWarnkarteProbability = (probability: unknown) => {
  const value = Number(probability);
  return Number.isFinite(value)
    ? `Wahrscheinlichkeit: ${Math.round(value * 100)} %`
    : "Wahrscheinlichkeit unbekannt";
};

export const attachPriwaWarnkarteInteraction = (
  map: Map,
  layer: ReturnType<typeof createPriwaWarnkarteLayer>,
) => {
  const element = document.createElement("div");
  element.className = "priwa-warnkarte-tooltip";
  element.setAttribute("role", "tooltip");
  const overlay = new Overlay({
    element,
    offset: [0, -10],
    positioning: "bottom-center",
    stopEvent: false,
  });
  map.addOverlay(overlay);

  const hide = () => overlay.setPosition(undefined);
  const clickKey = map.on("singleclick", (event) => {
    const feature = map.forEachFeatureAtPixel(
      event.pixel,
      (candidate) => candidate,
      {
        hitTolerance: 5,
        layerFilter: (candidateLayer) => candidateLayer === layer,
      },
    );

    if (!feature) {
      hide();
      return;
    }

    element.textContent = formatPriwaWarnkarteProbability(
      feature.get("probability"),
    );
    overlay.setPosition(event.coordinate);
  });
  const visibilityKey = layer.on("change:visible", () => {
    if (!layer.getVisible()) hide();
  });

  return () => {
    unByKey([clickKey, visibilityKey]);
    map.removeOverlay(overlay);
    element.remove();
  };
};
