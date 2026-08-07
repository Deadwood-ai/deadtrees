import { describe, expect, it } from "vitest";

import type { IPriwaWarnkarteOverlay } from "../../api/priwaWarnkarte";
import {
  PRIWA_WARNKARTE_RED_BANDS,
  createPriwaWarnkarteLayer,
  getPriwaWarnkarteBandIndex,
  getPriwaWarnkarteStyle,
  setPriwaWarnkarteLayerData,
} from "./createPriwaWarnkarteLayer";

const overlay: IPriwaWarnkarteOverlay = {
  version_id: "version-1",
  source_date: "2024-06-25",
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: 1,
      properties: { probability: 0.6 },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [8.1, 48.4],
            [8.2, 48.4],
            [8.2, 48.5],
            [8.1, 48.4],
          ],
        ],
      },
    },
  ],
};

describe("PRIWA Warnkarte layer", () => {
  it("maps 0.0 and 0.1 to the lightest band and 1.0 to the darkest", () => {
    expect(getPriwaWarnkarteBandIndex(0)).toBe(0);
    expect(getPriwaWarnkarteBandIndex(0.1)).toBe(0);
    expect(getPriwaWarnkarteBandIndex(0.2)).toBe(1);
    expect(getPriwaWarnkarteBandIndex(1)).toBe(9);
    expect(getPriwaWarnkarteStyle(1).getFill()?.getColor()).toBe(
      PRIWA_WARNKARTE_RED_BANDS[9],
    );
  });

  it("loads safe GeoJSON into an independent EPSG:3857 vector layer", () => {
    const layer = createPriwaWarnkarteLayer();

    setPriwaWarnkarteLayerData(layer, overlay);

    const features = layer.getSource()?.getFeatures() ?? [];
    expect(features).toHaveLength(1);
    expect(features[0].get("probability")).toBe(0.6);
    expect(features[0].getGeometry()?.getType()).toBe("Polygon");
  });
});
