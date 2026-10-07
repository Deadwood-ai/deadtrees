import { Settings } from "../config";
import type { IPrivateDatasetFiles } from "../api/datasetAccess";
import { IDataAccess } from "../types/dataset";

export interface IDatasetFileSource {
  id: number;
  data_access?: IDataAccess | string | null;
  cog_path?: string | null;
  thumbnail_path?: string | null;
  is_cog_done?: boolean | null;
}

export interface IDatasetFileUrls {
  cogUrl: string | null;
  thumbnailUrl: string | null;
}

/**
 * Whether the dataset has a map image. The COG path itself is only listed to owners,
 * staff and PRIWA members; everyone else fetches it from the API when the map opens.
 */
export const hasMapImage = (dataset: { cog_path?: string | null; is_cog_done?: boolean | null }): boolean =>
  !!(dataset.cog_path || dataset.is_cog_done);

/** Private datasets are never served statically; they need signed API addresses. */
export const isPrivateDataset = (dataset: Pick<IDatasetFileSource, "data_access">): boolean =>
  dataset.data_access === IDataAccess.private;

/**
 * Where the browser loads a dataset's COG and thumbnail from. Public and view-only
 * files use legacy URLs checked against current visibility; private files only from signed addresses
 * the API issued to the signed-in user (null until they are available).
 */
export function resolveDatasetFileUrls(
  dataset: IDatasetFileSource,
  privateFiles?: IPrivateDatasetFiles | null,
): IDatasetFileUrls {
  if (isPrivateDataset(dataset)) {
    return { cogUrl: privateFiles?.cog_url ?? null, thumbnailUrl: privateFiles?.thumbnail_url ?? null };
  }
  return {
    cogUrl: dataset.cog_path ? Settings.COG_BASE_URL + dataset.cog_path.replace(/^\/+/, "") : null,
    thumbnailUrl: dataset.thumbnail_path ? Settings.THUMBNAIL_URL + dataset.thumbnail_path.replace(/^\/+/, "") : null,
  };
}
