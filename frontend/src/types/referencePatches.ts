export type PatchResolution = 5 | 10 | 20;

export type PatchStatus = "pending" | "good" | "bad"; // Kept for UI display only, not in DB

export interface IReferencePatch {
  id: number;
  dataset_id: number;
  user_id: string;
  resolution_cm: PatchResolution;
  geometry: GeoJSON.Polygon; // In UTM projection (specified by utm_zone)
  parent_tile_id: number | null; // TODO: Rename to parent_patch_id in future migration
  patch_index: string; // Renamed from tile_index in DB
  utm_zone: string; // UTM zone for geometry (e.g., "32N", "33S")
  epsg_code: number; // EPSG code for UTM zone (e.g., 32632 for 32N, 32733 for 33S)

  // Bounding box for export (in UTM coordinates)
  bbox_minx: number;
  bbox_miny: number;
  bbox_maxx: number;
  bbox_maxy: number;

  // Coverage statistics
  aoi_coverage_percent: number | null;
  deadwood_prediction_coverage_percent: number | null;
  forest_cover_prediction_coverage_percent: number | null;

  // Reference label links
  reference_deadwood_label_id?: number | null;
  reference_forest_cover_label_id?: number | null;

  // Layer-specific validation (null = pending, true = good, false = bad)
  deadwood_validated: boolean | null;
  forest_cover_validated: boolean | null;

  created_at: string;
  updated_at: string;
}

export interface IPatchSession {
  dataset_id: number;
  is_locked: boolean;
  locked_by: string | null;
  locked_at: string | null;
}

export interface IPatchGenerationProgress {
  dataset_id: number;
  total_20cm: number;
  completed_20cm: number;
  total_10cm: number;
  good_10cm: number;
  bad_10cm: number;
  pending_10cm: number;
  total_5cm: number;
  good_5cm: number;
  bad_5cm: number;
  pending_5cm: number;
  // New layer-specific validation tracking
  deadwood_validated_5cm: number;
  deadwood_good_5cm: number;
  deadwood_bad_5cm: number;
  deadwood_pending_5cm: number;
  forest_cover_validated_5cm: number;
  forest_cover_good_5cm: number;
  forest_cover_bad_5cm: number;
  forest_cover_pending_5cm: number;
}

export interface IPatchPlacementDraft {
  resolution_cm: PatchResolution;
  center: [number, number];
}

export interface IPatchPhaseState {
  hasPlacementPatches: boolean;
  hasPendingQA: boolean;
  completionPercent: number;
}
