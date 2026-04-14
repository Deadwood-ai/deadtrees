import { FeatureCollection } from "geojson";

interface ICentroid {
  lng: number;
  lat: number;
}

export interface IThumbnail {
  file_name: string;
  url: string;
}
export enum IDataAccess {
  public = "public",
  private = "private",
  viewonly = "viewonly",
}

export enum UploadType {
  GEOTIFF = "geotiff",
  RAW_IMAGES_ZIP = "raw_images_zip",
}

export interface ILabelObject {
  dataset_id: number;
  user_id: string;
  file: File;
  file_alias: string;
  labels_description: string;
  file_type: string;
}

export enum IBiome {
  TropicalMoistForests = "Tropical and Subtropical Moist Broadleaf Forests",
  TropicalDryForests = "Tropical and Subtropical Dry Broadleaf Forests",
  TropicalConiferousForests = "Tropical and Subtropical Coniferous Forests",
  TemperateBroadleafForests = "Temperate Broadleaf and Mixed Forests",
  TemperateConiferousForests = "Temperate Coniferous Forests",
  BorealForests = "Boreal Forests/Taiga",
  TropicalGrasslands = "Tropical and Subtropical Grasslands, Savannas, and Shrublands",
  TemperateGrasslands = "Temperate Grasslands, Savannas, and Shrublands",
  FloodedGrasslands = "Flooded Grasslands and Savannas",
  MontaneGrasslands = "Montane Grasslands and Shrublands",
  Tundra = "Tundra",
  MediterraneanForests = "Mediterranean Forests, Woodlands, and Scrub",
  Deserts = "Deserts and Xeric Shrublands",
  Mangroves = "Mangroves",
}

export interface IDataset {
  id: number;
  user_id: string;
  created_at: string;
  file_name: string;
  license: string;
  platform: string;
  project_id: string | null;
  authors: string[] | null;
  aquisition_year: string;
  aquisition_month: string;
  aquisition_day: string;
  additional_information: string | null;
  data_access: IDataAccess;
  citation_doi: string | null;
  archived: boolean;
  ortho_file_name: string | null;
  ortho_file_size: number;
  bbox: string | null;
  sha256: string;
  current_status: string;
  is_upload_done: boolean;
  is_odm_done: boolean;
  is_ortho_done: boolean;
  is_cog_done: boolean;
  is_thumbnail_done: boolean;
  is_deadwood_done: boolean;
  is_forest_cover_done: boolean;
  is_metadata_done: boolean;
  is_audited: boolean;
  has_error: boolean;
  error_message: string | null;
  cog_file_name: string | null;
  cog_path: string | null;
  cog_file_size: number | null;
  thumbnail_file_name: string | null;
  thumbnail_path: string | null;
  admin_level_1: string | null;
  admin_level_2: string | null;
  admin_level_3: string | null;
  biome_name: string | null;
  has_labels: boolean;
  has_deadwood_prediction: boolean;
  ortho_upload_runtime?: number | null;
  freidata_doi?: string | null;
  has_ml_tiles: boolean | null;
  ml_tiles_completed_at?: string | null;

  // Audit status fields (from database view)
  final_assessment: "ready" | "fixable_issues" | "no_issues" | "exclude_completely" | null;
  deadwood_quality: "great" | "sentinel_ok" | "bad" | null;
  forest_cover_quality: "great" | "sentinel_ok" | "bad" | null;
  has_major_issue: boolean | null;
  audit_date: string | null;
  has_valid_acquisition_date?: boolean | null;
  has_valid_phenology?: boolean | null;
  audited_by: string | null;
  audited_by_email: string | null;

  // Quality flags for frontend display logic
  show_deadwood_predictions: boolean;
  show_forest_cover_predictions: boolean;
}

export interface ILabels {
  id: number;
  dataset_id: number;
  user_id: string;
  aoi: FeatureCollection;
  label: FeatureCollection;
  label_source: string;
  label_quality: number;
  created_at: string;
  label_type: string;
}

export enum ILicense {
  "CC BY" = "CC BY",
  "CC BY-SA" = "CC BY-SA",
  "CC BY-NC-SA" = "CC BY-NC-SA",
  "MIT" = "MIT",
}

export enum IPlatform {
  "drone",
  "airborne",
  "satellite",
}

export enum ISpectralProperties {
  "RGB",
  "NIRRGB",
}

export enum IStatus {
  "pending",
  "processing",
  "errored",
  "processed",
  "audited",
  "audit_failed",
}

export interface IStats {
  id: number;
  created_at: string;
  date: string;
  area_covered: number;
  orthophoto_count: number;
  countries_count: number;
  contributors_count: number;
}

