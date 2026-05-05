import { describe, expect, it } from "vitest";
import { dteAerialRelease, getDteAerialPatchImages } from "./releases";

describe("DTE aerial release assets", () => {
  it("uses the current dataset 3251 reference export seed", () => {
    const dataset3251 = dteAerialRelease.dteAerial.sites.find(
      (site) => site.id === 3251,
    );

    expect(dataset3251).toBeDefined();
    expect(dataset3251?.exportSeed).toBe("1776848107785");
    expect(dataset3251?.patchCount).toBe(21);

    const patch20cm = getDteAerialPatchImages(dataset3251!, 20);
    const patch10cm = getDteAerialPatchImages(dataset3251!, 10, 0);

    expect(patch20cm.rgb).toContain("/3251/png/3251_20_1776848107785_20cm.png");
    expect(patch10cm.rgb).toContain("/3251/png/3251_1776848107785_0_10cm.png");
  });
});
