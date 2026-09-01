import { describe, expect, it } from "vitest";
import { Style } from "ol/style";

import {
  createPriwaOfflineAreaFeature,
  createPriwaOfflineAreaLayer,
} from "./createPriwaOfflineAreaLayer";

describe("createPriwaOfflineAreaLayer", () => {
  it("renders each downloaded extent with a subtle fill and no outline", () => {
    const layer = createPriwaOfflineAreaLayer();
    const source = layer.getSource();
    const style = layer.getStyle();

    source?.addFeatures([
      createPriwaOfflineAreaFeature([0, 0, 100, 100]),
      createPriwaOfflineAreaFeature([50, 50, 150, 150]),
    ]);

    expect(source?.getFeatures()).toHaveLength(2);
    expect(style).toBeInstanceOf(Style);
    expect((style as Style).getFill()?.getColor()).toBe(
      "rgba(5, 150, 105, 0.18)",
    );
    expect((style as Style).getStroke()).toBeNull();
  });
});
