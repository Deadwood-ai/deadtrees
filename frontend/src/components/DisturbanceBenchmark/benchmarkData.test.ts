import { describe, expect, it } from "vitest";
import {
  availablePredictions,
  benchmarkTime,
  filterBenchmarkSites,
  initialFrameStart,
} from "./benchmarkData";
import type { IBenchmarkFrame, IBenchmarkSiteSummary } from "./types";

const frame = (date: string): IBenchmarkFrame => ({
  date,
  image: date,
  source: "fixture",
});

describe("benchmark product ordering", () => {
  const products = ["tmf", "gfc", "da", "dte", "efda"].map((id) => ({
    id,
    name: id,
    color: "#000",
    resolution: "10 m",
    definition: "Fixture",
  }));
  const predictions = (ids: string[]) => ({
    products: ids.map((id) => ({
      id,
      available: true,
      prediction: `${id}.png`,
    })),
  });
  it("keeps DTE first even when source and evaluation arrays are shuffled", () => {
    expect(
      availablePredictions(
        predictions(["gfc", "da", "tmf", "dte", "efda"]),
        products,
      ).map(({ product }) => product.id),
    ).toEqual(["dte", "da", "efda", "gfc", "tmf"]);
    expect(
      availablePredictions(
        predictions(["tmf", "efda", "dte", "gfc", "da"]),
        [...products].reverse(),
      ).map(({ product }) => product.id),
    ).toEqual(["dte", "da", "efda", "gfc", "tmf"]);
  });
  it("preserves relative order when regional product availability changes", () => {
    expect(
      availablePredictions(predictions(["efda", "gfc", "dte"]), products).map(
        ({ product }) => product.id,
      ),
    ).toEqual(["dte", "efda", "gfc"]);
    expect(
      availablePredictions(predictions(["tmf", "gfc", "dte"]), products).map(
        ({ product }) => product.id,
      ),
    ).toEqual(["dte", "gfc", "tmf"]);
  });
});
const site = (country: string, latitude: number): IBenchmarkSiteSummary => ({
  id: country,
  name: country,
  country,
  type: "Fire",
  year: 2024,
  center: [0, latitude],
  thumbnail: "",
  droneDate: "2024-07-01",
  areaHa: 1,
  detail: "",
});

describe("benchmark temporal selection", () => {
  it("positions composite months at mid-month without asserting an acquisition day", () => {
    expect(benchmarkTime("2024-07")).toBe(Date.parse("2024-07-15T12:00:00Z"));
  });
  it("starts a three-frame window around the nearest observation and clamps at both ends", () => {
    const frames = ["2024-01", "2024-03", "2024-05", "2024-07", "2024-09"].map(
      frame,
    );
    expect(initialFrameStart(frames, "2024-05-15")).toBe(1);
    expect(initialFrameStart(frames, "2023-01-01")).toBe(0);
    expect(initialFrameStart(frames, "2025-01-01")).toBe(2);
    expect(initialFrameStart(frames.slice(0, 1), "2024-05-15")).toBe(0);
  });
});

describe("benchmark geographical filters", () => {
  it("keeps all sites globally and distinguishes tropical latitude from Europe", () => {
    const sites = [
      site("Belgium", 51),
      site("Canada", 60),
      site("Indonesia", -7),
      site("Panama", 9),
    ];
    expect(filterBenchmarkSites(sites, "global")).toHaveLength(4);
    expect(
      filterBenchmarkSites(sites, "europe").map((item) => item.country),
    ).toEqual(["Belgium"]);
    expect(
      filterBenchmarkSites(sites, "tropical").map((item) => item.country),
    ).toEqual(["Indonesia", "Panama"]);
  });
});
