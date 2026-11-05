import { describe, expect, it } from "vitest";

import { datasetHeading, datasetPageMeta } from "./datasetMeta";
import { getPageMeta, getStaticPagePaths, normalizePath } from "./pageMeta";

describe("normalizePath", () => {
  it("gives one canonical form for trailing slashes and case", () => {
    expect(normalizePath("/about/")).toBe("/about");
    expect(normalizePath("/Dataset/5428")).toBe("/dataset/5428");
    expect(normalizePath("/")).toBe("/");
  });
});

describe("getPageMeta", () => {
  it("gives each public page its own title and description", () => {
    const pages = getStaticPagePaths().map(getPageMeta);
    expect(new Set(pages.map((page) => page.title)).size).toBe(pages.length);
    expect(new Set(pages.map((page) => page.description)).size).toBe(pages.length);
    expect(pages.every((page) => !page.noindex)).toBe(true);
  });

  it("keeps descriptions short enough for search results", () => {
    const tooLong = getStaticPagePaths().filter(
      (path) => getPageMeta(path).description.length > 165,
    );
    expect(tooLong).toEqual([]);
  });

  it.each([
    "/sign-in",
    "/sign-up",
    "/forgot-password",
    "/reset-password",
    "/profile",
    "/factory/datasets/12",
    "/dataset-audit/12/reference-patches",
    "/priwa-field",
    "/releases/disturbance-benchmark",
  ])("keeps %s out of search results", (path) => {
    expect(getPageMeta(path).noindex).toBe(true);
  });

  it("reads release pages from the release data", () => {
    expect(getPageMeta("/releases/drone-mapping-guide").title).toBe(
      "Drone mapping guide | deadtrees.earth",
    );
  });
});

describe("datasetPageMeta", () => {
  const dataset = {
    id: 42,
    license: "CC BY",
    platform: "drone",
    authors: ["Ada Forester"],
    aquisition_year: "2023",
    aquisition_month: "7",
    aquisition_day: "4",
    citation_doi: null,
    admin_level_1: "Germany",
    admin_level_2: "Baden-Württemberg",
    admin_level_3: "Freiburg",
  };

  it("names the place and year in the title", () => {
    expect(datasetHeading(dataset)).toBe(
      "Aerial forest orthophoto of Freiburg, Germany (2023)",
    );
    expect(datasetPageMeta(dataset).title).toContain("Freiburg, Germany");
  });

  it("builds structured data with a license URL and a date", () => {
    const { jsonLd, description } = datasetPageMeta(dataset);
    expect(jsonLd).toMatchObject({
      "@type": "Dataset",
      url: "https://deadtrees.earth/dataset/42",
      license: "https://creativecommons.org/licenses/by/4.0/",
      temporalCoverage: "2023-07-04",
      creator: [{ "@type": "Person", name: "Ada Forester" }],
    });
    expect(description).toContain("in Freiburg, Germany");
    expect(description).toContain("2023-07-04");
  });

  it("still describes a dataset with no place or date", () => {
    const bare = {
      ...dataset,
      aquisition_year: "",
      aquisition_month: "",
      aquisition_day: "",
      admin_level_1: null,
      admin_level_2: null,
      admin_level_3: null,
      authors: null,
    };
    expect(datasetHeading(bare)).toBe("Aerial forest orthophoto of dataset 42");
    expect(datasetPageMeta(bare).jsonLd).not.toHaveProperty("spatialCoverage");
  });
});
