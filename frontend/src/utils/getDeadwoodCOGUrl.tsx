const ASSETS_BASE_URL = "https://data2.deadtrees.earth/assets/v1/";

// Directory and filename prefix (up to the layer name) of each model version's COGs
const MODEL_VERSION_COGS = {
  v1: "dte_maps/run_v1004_v1000_crop_half_fold_None_checkpoint_199_",
  v5: "dte_maps_v5/run_v5001_v5000_no_early_stop_fold_None_checkpoint_19_",
} as const;

export type MapModelVersion = keyof typeof MODEL_VERSION_COGS;

export const MAP_MODEL_VERSIONS = Object.keys(MODEL_VERSION_COGS) as MapModelVersion[];

const getCOGUrl = (layer: "deadwood" | "forest", year: string, version: MapModelVersion) =>
  `${ASSETS_BASE_URL}${MODEL_VERSION_COGS[version]}${layer}_${year}.cog.tif`;

export const getDeadwoodCOGUrl = (year: string | null, version: MapModelVersion = "v1") => {
  if (!year || year.trim() === "") throw new Error("Invalid year for Deadwood COG URL");
  return getCOGUrl("deadwood", year, version);
};

export const getForestCOGUrl = (year: string | null, version: MapModelVersion = "v1") => {
  if (!year || year.trim() === "") throw new Error("Invalid year for Forest COG URL");
  return getCOGUrl("forest", year, version);
};

// Default export for backwards compatibility
export default getDeadwoodCOGUrl;
