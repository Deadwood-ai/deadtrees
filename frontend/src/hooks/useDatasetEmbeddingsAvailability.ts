import { useQuery } from "@tanstack/react-query";

import { supabase } from "./useSupabase";

export type DatasetEmbeddingsAvailability =
  | "loading"
  | "ready"
  | "unavailable"
  | "error";

/** Search-domain capability state for one dataset's tile embeddings. */
export function useDatasetEmbeddingsAvailability(
  datasetId: number | undefined,
) {
  const query = useQuery({
    queryKey: ["dataset-embeddings-availability", datasetId],
    enabled: Boolean(datasetId),
    // This small capability read should fail explicitly instead of keeping the
    // search control in a misleading loading state during automatic retries.
    retry: false,
    queryFn: async () => {
      if (!datasetId) return false;
      const { data, error } = await supabase
        .from("v2_statuses")
        .select("is_embeddings_done")
        .eq("dataset_id", datasetId)
        .maybeSingle();
      if (error) throw error;
      return data?.is_embeddings_done === true;
    },
  });

  let availability: DatasetEmbeddingsAvailability = "loading";
  if (query.isError) availability = "error";
  else if (query.data === true) availability = "ready";
  else if (query.data === false) availability = "unavailable";

  return { availability, error: query.error };
}
