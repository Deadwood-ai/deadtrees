import { GeoJSON } from "geojson";

export enum ILabelSource {
  MANUAL = "manual",
  AUTOMATIC = "automatic",
  SEMI_AUTOMATIC = "semi_automatic",
  MODEL_PREDICTION = "model_prediction",
  VISUAL_INTERPRETATION = "visual_interpretation",
  FIXED_MODEL_PREDICTION = "fixed_model_prediction",
  REFERENCE_PATCH = "reference_patch", // For reference patch curated data
}

export enum ILabelType {
  SEGMENTATION = "segmentation",
  POINT_OBSERVATION = "point_observation",
  INSTANCE_SEGMENTATION = "instance_segmentation",
  SEMANTIC_SEGMENTATION = "semantic_segmentation",
}

export enum ILabelData {
  DEADWOOD = "deadwood",
  FOREST_COVER = "forest_cover",
}

export interface IAOI {
  id: number;
  dataset_id: number;
  user_id: string;
  geometry: GeoJSON.Geometry;
  is_whole_image: boolean;
  image_quality?: number;
  notes?: string;
  created_at: string;
  updated_at: string;
}

export interface ILabel {
  id: number;
  dataset_id: number;
  aoi_id?: number;
  user_id: string;
  label_source: ILabelSource;
  label_type: ILabelType;
  label_data: ILabelData;
  label_quality?: number;
  model_config?: Record<string, any>;
  created_at: string;
  updated_at: string;

  // Version control fields for reference patch labels
  reference_patch_id?: number | null;
  version?: number;
  parent_label_id?: number | null;
  is_active?: boolean;
}

export interface IDeadwoodGeometry {
  id: number;
  label_id: number;
  geometry: GeoJSON.Geometry;
  properties?: Record<string, any>;
  created_at: string;
}

export interface IForestCoverGeometry {
  id: number;
  label_id: number;
  geometry: GeoJSON.Geometry;
  properties?: Record<string, any>;
  created_at: string;
}

// Reference patch geometry interfaces (NEW tables)
export interface IReferencePatchDeadwoodGeometry {
  id: number;
  label_id: number;
  patch_id: number;
  geometry: GeoJSON.Geometry; // Stored as JSONB in DB
  area_m2?: number | null;
  properties?: Record<string, any>;
  created_at: string;
}

export interface IReferencePatchForestCoverGeometry {
  id: number;
  label_id: number;
  patch_id: number;
  geometry: GeoJSON.Geometry; // Stored as JSONB in DB
  area_m2?: number | null;
  properties?: Record<string, any>;
  created_at: string;
}
