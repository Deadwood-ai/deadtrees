/** One row of v2_georef_checks: the georeferencing check of a dataset. */
export interface IGeorefCheck {
  dataset_id: number;
  model_version: string;
  rules_version: string;
  decision: "good" | "poor" | "uncertain";
  /** strong / qualified / gross decide; insufficient / conflict leave it uncertain */
  evidence_level: "strong" | "qualified" | "gross" | "insufficient" | "conflict";
  reason: string;
  /** median p90 offset (m) over the deciding references */
  p90_m: number | null;
  evidence_groups: number;
  support: number;
  edge_support: number;
  used_aoi: boolean;
  reference_evidence: IGeorefReferenceEvidence[];
  reference_errors: Record<string, string>;
  metadata: {
    seconds?: number;
    references?: Record<string, { zoom: number; capture_date: string | null; tile_url: string | null }>;
    [key: string]: unknown;
  };
  updated_at: string;
}

export interface IGeorefReferenceEvidence {
  provider: string;
  group: string;
  matches: number;
  inliers: number;
  inlier_fraction: number;
  cells: number;
  support: number;
  edge_support: number;
  p50_m: number | null;
  p90_m: number | null;
  holdout_p90_m: number[];
  vote: "good" | "poor" | "unstable" | null;
  qualified: boolean;
  decides: boolean;
  reason: string | null;
  /** inlier pairs [lon_drone, lat_drone, lon_reference, lat_reference] */
  sample_pairs: [number, number, number, number][];
}
