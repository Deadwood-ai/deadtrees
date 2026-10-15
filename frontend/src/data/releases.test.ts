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

describe("DTE-aerial-bench publication", () => {
  it("is available with a real download link instead of a placeholder", () => {
    expect(dteAerialRelease.status).toBe("available");
    expect(dteAerialRelease.links.artifact).toBe(
      "https://huggingface.co/datasets/ayushi3536/deadtree.earth-aerial-bench",
    );
  });

  it("serves bundled previews for the view-only GeoNadir sites only", () => {
    const viewOnlySites = dteAerialRelease.dteAerial.sites.filter(
      (site) => site.viewOnly,
    );
    expect(viewOnlySites.map((site) => site.id)).toEqual([4181, 4182, 4471]);

    const patch = getDteAerialPatchImages(viewOnlySites[0], 10, 2);
    expect(patch.rgb).toMatch(
      /^\/assets\/releases\/dte-aerial-bench\/4181\/4181_1768225381580_2_10cm\.webp\?v=/,
    );
    expect(patch.rgbPreview).toBe(patch.rgb);
    expect(patch.treeCoverMask).toMatch(
      /^\/assets\/releases\/dte-aerial-bench\/4181\/4181_1768225381580_2_10cm_forestcover_ref\.png\?v=/,
    );
  });
});

describe("DTE-aerial-bench gallery previews", () => {
  it("uses the exported WebP preview for cards and the full PNG for zoom", () => {
    const site = dteAerialRelease.dteAerial.sites.find((s) => s.id === 375)!;
    const patch = getDteAerialPatchImages(site, 5, 3);
    expect(patch.rgb).toContain("/375/png/375_0_3_5cm.png?v=");
    expect(patch.rgbPreview).toContain("/375/png/375_0_3_5cm_preview.webp?v=");
  });
});
