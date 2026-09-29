/** One row of v2_acquisition_date_estimates (processor stage doy_estimation_v1). */
export interface IAcquisitionDateEstimate {
  dataset_id: number;
  model_version: string;
  /** s2: dated with the Sentinel-2 weeks of the flight year; nos2: ortho + site only */
  model_type: "s2" | "nos2";
  /** calibrated probabilities over the flight year, 365 bins */
  probabilities: number[];
  flight_year: number;
  recorded_year: number | null;
  recorded_month: number | null;
  recorded_day: number | null;
  recorded_precision: "day" | "month" | "year";
  predicted_date: string;
  mode_date: string;
  /** highest-density sets as ISO date ranges, keyed by level ("50", "80", "95", "99") */
  hdi: Record<string, [string, string][]>;
  hdi80_days: number;
  n_modes: number;
  recorded_surprise: number | null;
  recorded_offset_days: number | null;
  is_mismatch: boolean;
  suggested_date: string | null;
  suggestion_reason: "missing_month" | "mismatch" | null;
  recommend_accept: boolean | null;
  metadata: {
    s2?: { status?: string; block?: string | null; block_status?: string | null; cube_end?: string | null };
    [key: string]: unknown;
  };
  updated_at: string;
}

/** One row of dataset_audit_suggestions: a machine-proposed audit form value. */
export interface IAuditSuggestion {
  dataset_id: number;
  field: string;
  value: unknown;
  source: string;
  reason: string | null;
  details: Record<string, unknown>;
  updated_at: string;
}
