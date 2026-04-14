import { supabase } from "./useSupabase";

interface BatchProgress {
  current: number;
  total: number;
  percentage: number;
  layer: "deadwood" | "forest_cover";
}

interface ClipGeometriesBatchParams {
  labelId: number;
  geometryTable: "v2_deadwood_geometries" | "v2_forest_cover_geometries";
  bbox: {
    minx: number;
    miny: number;
    maxx: number;
    maxy: number;
  };
  epsgCode: number;
  batchSize?: number;
  onProgress?: (progress: BatchProgress) => void;
}

interface BatchResult {
  geometry: unknown;
  total_count: number;
}

/**
 * Fetch and clip geometries in batches to avoid timeouts
 * Returns all clipped geometries as an array
 */
export async function clipGeometriesInBatches({
  labelId,
  geometryTable,
  bbox,
  epsgCode,
  batchSize = 50,
  onProgress,
}: ClipGeometriesBatchParams): Promise<unknown[]> {
  const allGeometries: unknown[] = [];
  let offset = 0;
  let totalCount: number | null = null;
  const layerType = geometryTable.includes("deadwood") ? "deadwood" : "forest_cover";

  console.debug(`[Batch Clipping] Starting for ${layerType}, label ${labelId}`);

  let hasMoreData = true;
  while (hasMoreData) {
    console.debug(`[Batch Clipping] Fetching batch at offset ${offset}`);

    // Call the optimized batch RPC
    const { data, error } = await supabase.rpc("get_clipped_geometries_batch", {
      p_label_id: labelId,
      p_geometry_table: geometryTable,
      p_bbox_minx: bbox.minx,
      p_bbox_miny: bbox.miny,
      p_bbox_maxx: bbox.maxx,
      p_bbox_maxy: bbox.maxy,
      p_epsg_code: epsgCode,
      p_buffer_m: 2.0,
      p_limit: batchSize,
      p_offset: offset,
    });

    if (error) {
      console.error(`[Batch Clipping] Error at offset ${offset}:`, error);
      throw error;
    }

    if (!data || data.length === 0) {
      console.debug(`[Batch Clipping] No more data at offset ${offset}`);
      hasMoreData = false;
      break;
    }

    // Extract total count from first batch
    if (totalCount === null && data.length > 0) {
      totalCount = (data[0] as BatchResult).total_count;
      console.debug(`[Batch Clipping] Total intersecting geometries: ${totalCount}`);
    }

    // Extract geometries from batch results
    const batchGeometries = data.map((row: BatchResult) => row.geometry);
    allGeometries.push(...batchGeometries);

    // Update progress
    if (onProgress && totalCount) {
      const progress: BatchProgress = {
        current: Math.min(offset + batchSize, totalCount),
        total: totalCount,
        percentage: Math.min(100, Math.round(((offset + batchSize) / totalCount) * 100)),
        layer: layerType,
      };
      onProgress(progress);
    }

    // If we got fewer results than batch size, we're done
    if (data.length < batchSize) {
      console.debug(`[Batch Clipping] Completed - got ${data.length} in final batch`);
      hasMoreData = false;
      break;
    }

    offset += batchSize;
  }

  console.debug(`[Batch Clipping] Complete - ${allGeometries.length} geometries clipped`);
  return allGeometries;
}
