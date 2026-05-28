export type MapModelVersion = "v1" | "v2";

const V1_BASE_URL = "https://data2.deadtrees.earth/assets/v1/dte_maps/";
const V2_BASE_URL = "https://data2.deadtrees.earth/assets/v1/dte_maps_v2/";

const V1_DEADWOOD_PREFIX = "run_v1004_v1000_crop_half_fold_None_checkpoint_199_deadwood_";
const V1_FOREST_PREFIX = "run_v1004_v1000_crop_half_fold_None_checkpoint_199_forest_";
const V2_DEADWOOD_PREFIX = "run_v2004_seasonal_filter_fold_None_epoch_3_deadwood_";
const V2_FOREST_PREFIX = "run_v2004_seasonal_filter_fold_None_epoch_3_forest_";

export const getDeadwoodCOGUrl = (year: string | null, version: MapModelVersion = "v1") => {
  if (version === "v2") {
    return `${V2_BASE_URL}${V2_DEADWOOD_PREFIX}${year}.cog.tif`;
  }
  return `${V1_BASE_URL}${V1_DEADWOOD_PREFIX}${year}.cog.tif`;
};

export const getForestCOGUrl = (year: string | null, version: MapModelVersion = "v1") => {
  if (version === "v2") {
    return `${V2_BASE_URL}${V2_FOREST_PREFIX}${year}.cog.tif`;
  }
  return `${V1_BASE_URL}${V1_FOREST_PREFIX}${year}.cog.tif`;
};

// Default export for backwards compatibility
export default getDeadwoodCOGUrl;
