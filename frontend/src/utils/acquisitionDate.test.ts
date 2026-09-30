import { describe, expect, it } from "vitest";
import type { IAcquisitionDateDecision, IAcquisitionDateEstimate, IAuditSuggestion } from "../types/acquisitionDate";
import {
  binToDate,
  dateToYearFraction,
  datasetDateSuggestion,
  isEstimateCurrent,
  joinYearWrap,
  activeDecision,
  evidenceText,
  formatDateParts,
  modelSuggestedDecision,
  decisionDistribution,
  suggestedAuditValues,
} from "./acquisitionDate";

const estimate = (over: Partial<IAcquisitionDateEstimate> = {}): IAcquisitionDateEstimate => ({
  dataset_id: 1,
  model_version: "doy_estimation_v1",
  model_type: "s2",
  probabilities: new Array(365).fill(1 / 365),
  flight_year: 2022,
  recorded_year: 2022,
  recorded_month: 3,
  recorded_day: 24,
  recorded_precision: "day",
  predicted_date: "2022-07-10",
  mode_date: "2022-07-09",
  hdi: { "80": [["2022-06-20", "2022-08-01"]] },
  hdi80_days: 42,
  n_modes: 1,
  recorded_surprise: 0.999,
  recorded_offset_days: 108,
  is_mismatch: true,
  suggested_date: "2022-07-10",
  suggestion_reason: "mismatch",
  recommend_accept: true,
  metadata: {},
  updated_at: "2026-09-30T00:00:00Z",
  ...over,
});

const suggestion = (field: string, value: unknown): IAuditSuggestion => ({
  dataset_id: 1,
  field,
  value,
  source: "doy_estimation_v1",
  reason: null,
  details: {},
  updated_at: "2026-09-30T00:00:00Z",
});

describe("acquisition date estimate helpers", () => {
  it("shows the suggestion only while the dataset keeps the assessed date", () => {
    const ds = { aquisition_year: 2022, aquisition_month: 3, aquisition_day: 24 };
    expect(datasetDateSuggestion(estimate(), ds)).toEqual({ date: "2022-07-10", reason: "mismatch" });
    // after an accepted suggestion the dataset carries the new date
    expect(datasetDateSuggestion(estimate(), { aquisition_year: 2022, aquisition_month: 7, aquisition_day: 10 })).toBeNull();
    expect(datasetDateSuggestion(estimate({ suggested_date: null, suggestion_reason: null }), ds)).toBeNull();
    expect(datasetDateSuggestion(null, ds)).toBeNull();
  });

  it("compares string and missing date parts like the database", () => {
    const e = estimate({ recorded_month: null, recorded_day: null });
    expect(isEstimateCurrent(e, { aquisition_year: "2022", aquisition_month: null, aquisition_day: undefined })).toBe(true);
    expect(isEstimateCurrent(e, { aquisition_year: 2022, aquisition_month: 5 })).toBe(false);
  });

  it("prefills only the audit fields a human left empty", () => {
    const suggestions = [
      suggestion("has_valid_acquisition_date", false),
      suggestion("accept_suggested_acquisition_date", true),
      suggestion("acquisition_date_notes", "Date model ..."),
    ];
    expect(suggestedAuditValues(null, suggestions).fields).toEqual([
      "has_valid_acquisition_date",
      "accept_suggested_acquisition_date",
      "acquisition_date_notes",
    ]);
    const { values } = suggestedAuditValues({ has_valid_acquisition_date: true, acquisition_date_notes: "" }, suggestions);
    expect(values).toEqual({ accept_suggested_acquisition_date: true, acquisition_date_notes: "Date model ..." });
    // a reopened date check offers the suggestion over the previous verdict, but keeps notes
    const reopened = suggestedAuditValues(
      { has_valid_acquisition_date: true, accept_suggested_acquisition_date: false, acquisition_date_notes: "mine" },
      suggestions,
      ["has_valid_acquisition_date", "accept_suggested_acquisition_date"],
    );
    expect(reopened.values).toEqual({ has_valid_acquisition_date: false, accept_suggested_acquisition_date: true });
  });

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
