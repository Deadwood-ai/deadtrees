import { describe, expect, it } from "vitest";
import {
  dteAerialRelease,
  getDteAerialPatchImages,
  getPublicReleaseBySlug,
  getReleaseHref,
  getReleaseStats,
  publicReleases,
  satelliteMapRelease,
} from "./releases";

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

describe("Sentinel-2 satellite map release", () => {
  it("is listed first and available", () => {
    expect(publicReleases[0]).toBe(satelliteMapRelease);
    expect(satelliteMapRelease.status).toBe("available");
    expect(getPublicReleaseBySlug("sentinel-2-satellite-map")).toBe(
      satelliteMapRelease,
    );
  });

  it("opens the live satellite map instead of a release detail page", () => {
    expect(getReleaseHref(satelliteMapRelease)).toBe("/deadtrees");
    expect(getReleaseHref(dteAerialRelease)).toBe("/releases/dte-aerial-bench");
  });

  it("uses the bundled map screenshot as its preview", () => {
    expect(satelliteMapRelease.map.previewImage).toBe(
      "/assets/releases/sentinel-2-satellite-map.webp",
    );
    expect(satelliteMapRelease.map.previewAlt).not.toBe("");
  });

  it("reports the years and coverage the map shows", () => {
    expect(getReleaseStats(satelliteMapRelease)).toEqual([
      { label: "Years", value: "2017–2025" },
      { label: "Annual maps", value: "9" },
      { label: "Coverage", value: "Europe" },
    ]);
  });
});
