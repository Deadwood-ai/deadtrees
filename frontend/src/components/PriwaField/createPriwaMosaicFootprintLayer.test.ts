import { describe, expect, it } from "vitest";

import {
  createPriwaMosaicFootprintFeature,
  createPriwaMosaicFootprintLayer,
} from "./createPriwaMosaicFootprintLayer";
import type { IPriwaMosaic } from "./usePriwaMosaics";

const mosaic: IPriwaMosaic = {
  id: "10513",
  projectId: "project-1",
  label: "DJI_202606170942_031_42_Vorderbuehl.zip",
  cogUrl: "project/10513_cog.tif",
  bbox: "BOX(8.1 48.4,8.2 48.5)",
  captureDate: "2026-06-22",
  createdAt: "2026-06-22T10:00:00.000Z",
  authors: ["PRIWA Wald"],
  additionalInformation: null,
  flightType: null,
};

describe("createPriwaMosaicFootprintLayer", () => {
  it("creates an outline feature from a dataset bbox", () => {
    const feature = createPriwaMosaicFootprintFeature({
      mosaic,
      isSelected: false,
      isVisible: true,
    });

    expect(feature?.get("mosaicId")).toBe("10513");
    expect(feature?.getGeometry()?.getType()).toBe("Polygon");
    const styles = feature?.getStyle();
    expect(Array.isArray(styles)).toBe(true);
    if (!Array.isArray(styles)) throw new Error("Expected layered COG style");
    expect(styles).toHaveLength(2);
    expect(styles?.[0].getStroke()?.getWidth()).toBe(5);
    expect(styles?.[1].getStroke()?.getColor()).toBe(
      "rgba(251, 146, 60, 1)",
    );
  });

  it("uses a high-contrast cyan accent for hidden COG boundaries", () => {
    const feature = createPriwaMosaicFootprintFeature({
      mosaic,
      isSelected: false,
      isVisible: false,
    });
    const styles = feature?.getStyle();

    expect(Array.isArray(styles)).toBe(true);
    if (!Array.isArray(styles)) throw new Error("Expected layered COG style");
    expect(styles?.[1].getStroke()?.getColor()).toBe(
      "rgba(34, 211, 238, 1)",
    );
  });

  it("skips mosaics without parseable bbox values", () => {
    expect(
      createPriwaMosaicFootprintFeature({
        mosaic: { ...mosaic, bbox: null },
        isSelected: false,
        isVisible: true,
      }),
    ).toBeNull();
    expect(
      createPriwaMosaicFootprintFeature({
        mosaic: { ...mosaic, bbox: "invalid" },
        isSelected: false,
        isVisible: true,
      }),
    ).toBeNull();
  });

  it("creates a vector layer for footprint features", () => {
    expect(createPriwaMosaicFootprintLayer().getSource()).toBeTruthy();
  });
});
