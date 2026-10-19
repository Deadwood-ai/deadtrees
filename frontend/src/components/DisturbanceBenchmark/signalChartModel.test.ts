import { describe, expect, it } from "vitest";
import { createSignalChartModel } from "./signalChartModel";
import { benchmarkTime } from "./benchmarkData";
import type { IBenchmarkSite } from "./types";

const site: IBenchmarkSite = {
  id: "fixture",
  name: "Fixture",
  country: "Canada",
  type: "Dieback",
  year: 2023,
  center: [0, 60],
  thumbnail: "",
  droneDate: "2023-07-01",
  areaHa: 1,
  detail: "",
  drone: "",
  reference: "",
  width: 100,
  height: 100,
  crs: "EPSG:32608",
  previewResolution: 1,
  products: [],
  series: [],
  notes: [],
  contexts: {
    google: [{ date: "2026-07-13", image: "later.jpg", source: "fixture" }],
  },
  provenance: {
    imageryVersion: "fixture",
    evaluationVersion: "fixture",
    window: "2022–2023",
    threshold: 0.25,
  },
};
const sentinel = [
  { date: "2015-07-01", value: 0.8 },
  { date: "2023-06-01", value: 0.6 },
];
const planet = [{ date: "2023-07", value: 0.4 }];

describe("combined imagery time window", () => {
  it("keeps the close-up fixed when displayed Google frames lie outside the evaluation years", () => {
    const chart = createSignalChartModel(
      site,
      site.contexts.google!,
      sentinel,
      planet,
      false,
    );
    expect(chart.minimum).toBe(benchmarkTime("2022-01-01"));
    expect(chart.maximum).toBe(benchmarkTime("2023-12-31"));
    expect(chart.inWindow("2026-07-13")).toBe(false);
    expect(chart.visibleSentinel).toEqual([sentinel[1]]);
  });
  it("includes both the early Sentinel record and later Google imagery in Full record", () => {
    const chart = createSignalChartModel(
      site,
      site.contexts.google!,
      sentinel,
      planet,
      true,
    );
    expect(chart.minimum).toBe(benchmarkTime("2015-07-01"));
    expect(chart.maximum).toBe(benchmarkTime("2026-07-13"));
    expect(chart.inWindow("2026-07-13")).toBe(true);
  });
});
