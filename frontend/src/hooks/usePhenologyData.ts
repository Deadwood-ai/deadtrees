import { useQuery } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { PhenologyMetadata } from "../types/phenology";

export function usePhenologyData(datasetId: number | undefined) {
  return useQuery({
    queryKey: ["phenology-data", datasetId],
    queryFn: async () => {
      if (!datasetId) return null;

      const { data, error } = await supabase
        .from("v2_metadata")
        .select("metadata")
        .eq("dataset_id", datasetId)
        .single();

      if (error) {
        if (error.code === "PGRST116") {
          // No data found
          return null;
        }
        throw error;
      }

      if (!data?.metadata?.phenology) {
        return null;
      }

      return data.metadata.phenology as PhenologyMetadata;
    },
    enabled: !!datasetId,
    staleTime: 5 * 60 * 1000, // 5 minutes cache
  });
}
