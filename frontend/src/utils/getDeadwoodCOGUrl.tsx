const baseUrl = "https://data2.deadtrees.earth/assets/v1/dte_maps/";

export const getDeadwoodCOGUrl = (year: string | null) => {
  return `${baseUrl}run_v1004_v1000_crop_half_fold_None_checkpoint_199_deadwood_${year}.cog.tif`;
};

export const getForestCOGUrl = (year: string | null) => {
  return `${baseUrl}run_v1004_v1000_crop_half_fold_None_checkpoint_199_forest_${year}.cog.tif`;
};

// Default export for backwards compatibility
export default getDeadwoodCOGUrl;
