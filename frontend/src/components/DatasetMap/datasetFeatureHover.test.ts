import { describe, expect, it, vi } from "vitest";
import Feature from "ol/Feature";
import Style from "ol/style/Style";

import { transitionDatasetFeatureHover } from "./datasetFeatureHover";

const createFeaturePair = () => {
  const baseStyle = new Style();
  const hoverStyle = new Style();
  const features = [new Feature(), new Feature()];

  for (const feature of features) {
    feature.setProperties({ baseStyle, hoverStyle });
    feature.setStyle(baseStyle);
  }

  return { features, baseStyle, hoverStyle };
};

describe("transitionDatasetFeatureHover", () => {
  it("does no styling work when the hovered dataset is unchanged", () => {
    const first = createFeaturePair();
    const featuresById = new Map([[1, first.features]]);
    const spies = first.features.map((feature) => vi.spyOn(feature, "setStyle"));

    expect(transitionDatasetFeatureHover(featuresById, 1, 1)).toBe(1);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("styles only the newly hovered dataset", () => {
    const first = createFeaturePair();
    const unrelated = createFeaturePair();
    const featuresById = new Map([
      [1, first.features],
      [2, unrelated.features],
    ]);
    const firstSpies = first.features.map((feature) => vi.spyOn(feature, "setStyle"));
    const unrelatedSpies = unrelated.features.map((feature) => vi.spyOn(feature, "setStyle"));

    expect(transitionDatasetFeatureHover(featuresById, null, 1)).toBe(1);
    for (const spy of firstSpies) expect(spy).toHaveBeenCalledOnce();
    for (const spy of firstSpies) expect(spy).toHaveBeenCalledWith(first.hoverStyle);
    for (const spy of unrelatedSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("resets only the previous dataset and highlights only the next dataset", () => {
    const first = createFeaturePair();
    const second = createFeaturePair();
    const unrelated = createFeaturePair();
    const featuresById = new Map([
      [1, first.features],
      [2, second.features],
      [3, unrelated.features],
    ]);
    const firstSpies = first.features.map((feature) => vi.spyOn(feature, "setStyle"));
    const secondSpies = second.features.map((feature) => vi.spyOn(feature, "setStyle"));
    const unrelatedSpies = unrelated.features.map((feature) => vi.spyOn(feature, "setStyle"));

    expect(transitionDatasetFeatureHover(featuresById, 1, 2)).toBe(2);
    for (const spy of firstSpies) expect(spy).toHaveBeenCalledOnce();
    for (const spy of firstSpies) expect(spy).toHaveBeenCalledWith(first.baseStyle);
    for (const spy of secondSpies) expect(spy).toHaveBeenCalledOnce();
    for (const spy of secondSpies) expect(spy).toHaveBeenCalledWith(second.hoverStyle);
    for (const spy of unrelatedSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("resets only the previous dataset when the pointer moves to empty map space", () => {
    const first = createFeaturePair();
    const unrelated = createFeaturePair();
    const featuresById = new Map([
      [1, first.features],
      [2, unrelated.features],
    ]);
    const firstSpies = first.features.map((feature) => vi.spyOn(feature, "setStyle"));
    const unrelatedSpies = unrelated.features.map((feature) => vi.spyOn(feature, "setStyle"));

    expect(transitionDatasetFeatureHover(featuresById, 1, null)).toBeNull();
    for (const spy of firstSpies) expect(spy).toHaveBeenCalledOnce();
    for (const spy of firstSpies) expect(spy).toHaveBeenCalledWith(first.baseStyle);
    for (const spy of unrelatedSpies) expect(spy).not.toHaveBeenCalled();
  });
});
