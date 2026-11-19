import { describe, expect, it } from "vitest";
import { approvedBenchmarkSites } from "./approvedSiteSelection";
import selection from "./approvedSiteSelection.json";
import type { IBenchmarkSiteSummary } from "./types";

const site = (id: string): IBenchmarkSiteSummary => ({
  id,
  name: id,
  country: "Test",
  type: "Logging",
  year: 2024,
  center: [0, 0],
  thumbnail: "",
  droneDate: "",
  areaHa: 1,
  detail: `${id}/site.json`,
});

describe("Claudia's pinned approved-site selection", () => {
  it("contains 104 unique approved IDs from the 18 November sheet snapshot", () => {
    expect(selection.approvedSiteIds).toHaveLength(104);
    expect(new Set(selection.approvedSiteIds).size).toBe(104);
    expect(selection.acceptedStatus).toBe("ok");
  });
  it("excludes withdrawn and unknown sites without changing approved data or order", () => {
    const retained = [site("Mining_Laos_2024"), site("Dieback_Brazil5_2017")];
    const entries = [
      site("Fire_Mexico_2025"),
      retained[0],
      site("future-unreviewed"),
      retained[1],
      site("Logging_Germany2_2021"),
    ];
    expect(approvedBenchmarkSites(entries)).toEqual(retained);
    expect(approvedBenchmarkSites(entries)[0]).toBe(retained[0]);
    expect(entries).toHaveLength(5);
  });
  it("does not invent missing approved sites in a smaller export", () => {
    expect(approvedBenchmarkSites([])).toEqual([]);
    expect(approvedBenchmarkSites([site("Mining_Laos_2024")])).toHaveLength(1);
  });
});
