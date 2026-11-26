import { describe, expect, it } from "vitest";
import type { IDatasetAuditSummary } from "../types/auditChecks";
import { auditSettled, cropReasoning, georefFinding, predictionFinding, readableReason } from "./datasetAuditSummary";

const summary = (patch: Partial<IDatasetAuditSummary> = {}): IDatasetAuditSummary => ({
  review_required: [],
  evaluation_decision: "ok",
  georef_status: "estimated",
  georef_offset_m: 2.62,
  deadwood_total: 16,
  deadwood_major: 0,
  deadwood_minor: 14,
  forest_cover_total: 16,
  forest_cover_major: 3,
  forest_cover_minor: 0,
  ...patch,
});

describe("the dataset page's audit rows", () => {
  it("shows findings only once no review is required", () => {
    expect(auditSettled(summary())).toBe(true);
    expect(auditSettled(summary({ review_required: ["georef"] }))).toBe(false);
    expect(auditSettled(summary({ evaluation_decision: null }))).toBe(false);
    expect(auditSettled(null)).toBe(false);
  });

  it("says how far the image is off and how many sample crops a prediction gets wrong", () => {
    expect(georefFinding(summary())).toBe("About 2.6 m off");
    expect(georefFinding(summary({ georef_status: "no_reference", georef_offset_m: null }))).toBe("No reference imagery");
    expect(predictionFinding(16, 0, 14)).toBe("0/16 major, 14 minor");
    expect(predictionFinding(16, 3, 0)).toBe("3/16 major, 0 minor");
    expect(predictionFinding(null, null, null)).toBeNull();
  });

  it("drops the error type codes from the model's reasoning", () => {
    expect(readableReason("Brown crown has no blue (m1).")).toBe("Brown crown has no blue.");
    expect(readableReason("Brown patch has no blue (m1, low confidence).")).toBe("Brown patch has no blue (low confidence).");
    expect(readableReason("No straight seams (m7 absent).")).toBe("No straight seams.");
  });

  it("drops the pixel positions the page does not show", () => {
    expect(readableReason("Upper-centre dead branches (about x 520-625, y 60-210) are covered; no error.")).toBe("Upper-centre dead branches are covered; no error.");
    expect(readableReason("Small blue spot near x 812-852, y 465-482 sits on foliage.")).toBe("Small blue spot sits on foliage.");
    expect(readableReason("Upper-left tree at about (350,205) is marked dead (m2, small).")).toBe("Upper-left tree is marked dead (small).");
    expect(readableReason("Some blue at the edge (about 260-320, 730-800) may cover foliage.")).toBe("Some blue at the edge may cover foliage.");
  });

  it("prefers the model's summary to its error sentences", () => {
    expect(cropReasoning({ summary: "Most dead crowns are covered.", errors: ["x"] })).toBe("Most dead crowns are covered.");
    expect(cropReasoning({ summary: null, errors: ["Gap (m5).", "Shrub marked (m6)."] })).toBe("Gap. Shrub marked.");
  });
});
