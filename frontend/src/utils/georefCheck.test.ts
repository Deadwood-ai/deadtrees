import { describe, expect, it } from "vitest";
import type { IGeorefCheck, IGeorefReferenceEvidence } from "../types/georefCheck";
import { describeReference, offsetColor, orderedReferences, summarizeGeorefCheck } from "./georefCheck";

const ref = (provider: string, decides: boolean, inliers: number): IGeorefReferenceEvidence => ({
  provider,
  group: provider.startsWith("wayback") ? "esri" : provider,
  matches: inliers,
  inliers,
  inlier_fraction: 0.9,
  cells: 12,
  support: 0.9,
  edge_support: 0.9,
  p50_m: 2,
  p90_m: 3,
  holdout_p90_m: [3, 3.2],
  vote: decides ? "good" : null,
  qualified: decides,
  decides,
  reason: decides ? null : "no_fit",
  sample_pairs: [],
});

const check = (overrides: Partial<IGeorefCheck>): IGeorefCheck => ({
  dataset_id: 1,
  model_version: "romav2.0.1",
  rules_version: "georef-rules-v1",
  decision: "good",
  evidence_level: "strong",
  reason: "references_agree",
  p90_m: 2.74,
  evidence_groups: 2,
  support: 0.95,
  edge_support: 0.9,
  used_aoi: true,
  reference_evidence: [ref("google", true, 900), ref("esri", true, 2400), ref("maptiler", false, 3)],
  reference_errors: {},
  metadata: { references: { "wayback-123": { group: "esri", zoom: 19, capture_date: "2021-06-10", viewer: { kind: "xyz", url: "https://x/{z}/{y}/{x}", max_zoom: 19, attribution: "Esri" } } } },
  updated_at: "2026-10-02T00:00:00Z",
  ...overrides,
});

describe("georeferencing check display", () => {
  it("summarizes a decided check with the measured offset and evidence strength", () => {
    expect(summarizeGeorefCheck(check({}))).toEqual({
      tone: "success",
      verdict: "Good, 2.7 m off",
      detail: "Strong evidence: 90% of the area is within this offset of Esri World Imagery (current), google.",
    });
    expect(summarizeGeorefCheck(check({ decision: "poor", evidence_level: "qualified", p90_m: 22.6 })).tone).toBe("error");
  });

  it("asks for a look by eye when the check is uncertain, naming why", () => {
    const summary = summarizeGeorefCheck(check({ decision: "uncertain", evidence_level: "insufficient", reason: "no_qualified_reference", p90_m: null }));
    expect(summary.tone).toBe("warning");
    expect(summary.verdict).toBe("Uncertain");
    expect(summary.detail).toContain("No reference image matched reliably");
  });

  it("lists deciding references first, then by matches", () => {
    expect(orderedReferences(check({})).map((r) => r.provider)).toEqual(["esri", "google", "maptiler"]);
  });

  it("names Wayback references by their capture date", () => {
    expect(describeReference(check({}), "wayback-123")).toBe("Esri Wayback, captured 2021-06-10");
    expect(describeReference(check({}), "esri")).toBe("Esri World Imagery (current)");
  });

  it("colours matches by the 15 m audit line", () => {
    expect([offsetColor(3), offsetColor(10), offsetColor(20)]).toEqual(["#2f9e44", "#e8a10c", "#d6336c"]);
  });
});
