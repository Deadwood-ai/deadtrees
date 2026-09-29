import type { IAcquisitionDateEstimate, IAuditSuggestion } from "../types/acquisitionDate";

export const DOY_BINS = 365;

type DatasetDate = {
  aquisition_year?: number | string | null;
  aquisition_month?: number | string | null;
  aquisition_day?: number | string | null;
};

const asNumber = (v: number | string | null | undefined) =>
  v === null || v === undefined || v === "" ? null : Number(v);

/** The estimate was assessed against the date the dataset still carries. */
export function isEstimateCurrent(estimate: IAcquisitionDateEstimate, dataset: DatasetDate): boolean {
  return (
    estimate.recorded_year === asNumber(dataset.aquisition_year) &&
    estimate.recorded_month === asNumber(dataset.aquisition_month) &&
    estimate.recorded_day === asNumber(dataset.aquisition_day)
  );
}

/** The model's suggested date for the dataset page, or null when there is none
 * or the dataset date changed since (for example after an accepted suggestion). */
export function datasetDateSuggestion(
  estimate: IAcquisitionDateEstimate | null | undefined,
  dataset: DatasetDate,
): { date: string; reason: "missing_month" | "mismatch" } | null {
  if (!estimate?.suggested_date || !estimate.suggestion_reason) return null;
  if (!isEstimateCurrent(estimate, dataset)) return null;
  return { date: estimate.suggested_date, reason: estimate.suggestion_reason };
}

/** Audit form values proposed by machine suggestions for fields the saved
 * audit leaves empty. Saved (human) values always win. */
export function suggestedAuditValues(
  saved: Record<string, unknown> | null | undefined,
  suggestions: IAuditSuggestion[],
): { values: Record<string, unknown>; fields: string[] } {
  const values: Record<string, unknown> = {};
  for (const s of suggestions) {
    const current = saved?.[s.field];
    if (current === null || current === undefined || current === "") values[s.field] = s.value;
  }
  return { values, fields: Object.keys(values) };
}

/** Day-of-year fraction [0, 1) of an ISO date, on the model's 365-bin circle. */
export function dateToYearFraction(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  const start = Date.UTC(y, 0, 1);
  const days = (Date.UTC(y + 1, 0, 1) - start) / 86400000;
  return (Date.UTC(y, m - 1, d) - start) / 86400000 / days;
}

/** Calendar date of a bin start, as the processor computes it. */
export function binToDate(bin: number, year: number): Date {
  const days = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000;
  return new Date(Date.UTC(year, 0, 1 + Math.floor((bin * days) / DOY_BINS)));
}

export function formatIsoDate(iso: string, options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { ...options, timeZone: "UTC" });
}

export function describeModelType(estimate: Pick<IAcquisitionDateEstimate, "model_type">): string {
  return estimate.model_type === "s2" ? "orthophoto + Sentinel-2" : "orthophoto only (no Sentinel-2)";
}

/** HDI ranges for display: a season running over New Year is stored as two
 * ranges (Jan 1..x and y..Dec 31); show it as one, starting in December. */
export function joinYearWrap(ranges: [string, string][]): [string, string][] {
  if (ranges.length < 2) return ranges;
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  if (!first[0].endsWith("-01-01") || !last[1].endsWith("-12-31")) return ranges;
  return [[last[0], first[1]], ...ranges.slice(1, -1)];
}
