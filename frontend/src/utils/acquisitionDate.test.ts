import { describe, expect, it } from "vitest";
import type { IAcquisitionDateDecision } from "../types/acquisitionDate";
import {
  binToDate,
  dateToYearFraction,
  joinYearWrap,
  activeDecision,
  evidenceText,
  formatDateParts,
  modelSuggestedDecision,
  decisionDistribution,
} from "./acquisitionDate";

describe("acquisition date estimate helpers", () => {
  it("joins a season that runs over New Year", () => {
    expect(
      joinYearWrap([
        ["2023-01-01", "2023-01-03"],
        ["2023-01-22", "2023-03-27"],
        ["2023-11-05", "2023-12-31"],
      ]),
    ).toEqual([
      ["2023-11-05", "2023-01-03"],
      ["2023-01-22", "2023-03-27"],
    ]);
    expect(joinYearWrap([["2023-06-01", "2023-07-01"]])).toEqual([["2023-06-01", "2023-07-01"]]);
  });

  it("maps dates and bins on the model's 365-bin year", () => {
    expect(dateToYearFraction("2023-01-01")).toBe(0);
    expect(binToDate(0, 2024).toISOString().slice(0, 10)).toBe("2024-01-01");
    expect(binToDate(364, 2023).toISOString().slice(0, 10)).toBe("2023-12-31");
  });

  it("recognises a date that came from an accepted suggestion", () => {
    const accepted = decision({ suggestion_decision: "accepted", resulting_month: 7, resulting_day: 19 });
    const old = decision({ id: 1, superseded_at: "2026-09-29T00:00:00Z", superseded_reason: "new_decision" });
    const ds = { aquisition_year: 2022, aquisition_month: 7, aquisition_day: 19 };
    expect(activeDecision([accepted, old])?.id).toBe(2);
    expect(modelSuggestedDecision([accepted, old], ds)?.id).toBe(2);
    // edited by hand afterwards: no longer the model's date
    expect(modelSuggestedDecision([accepted], { ...ds, aquisition_day: 20 })).toBeNull();
    expect(modelSuggestedDecision([decision({})], ds)).toBeNull();
    expect(decisionDistribution(decision({ evidence: {} }))).toBeNull();
  });

  it("explains the evidence and formats partial dates", () => {
    expect(evidenceText({ suggestion_reason: "mismatch", recorded_offset_days: 130.4 })).toContain("130 days");
    expect(evidenceText({ suggestion_reason: "missing_month" })).toBe("The reported date has no month.");
    expect(formatDateParts(2021, null, null)).toBe("2021 (no month)");
    expect(formatDateParts(2022, 3, 11)).toBe("11 March 2022");
  });
});

function decision(over: Partial<IAcquisitionDateDecision>): IAcquisitionDateDecision {
  return {
    id: 2,
    dataset_id: 1,
    source: "auditor",
    decided_by: null,
    decided_at: "2026-09-30T00:00:00Z",
    date_valid: false,
    suggestion_decision: null,
    suggested_date: "2022-07-19",
    reported_year: 2022,
    reported_month: 3,
    reported_day: 11,
    resulting_year: 2022,
    resulting_month: 3,
    resulting_day: 11,
    estimate_model_version: "doy_estimation_v1",
    estimate_model_type: "s2",
    evidence: {},
    superseded_at: null,
    superseded_reason: null,
    ...over,
  };
}
