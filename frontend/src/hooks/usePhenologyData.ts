import { useQuery } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { PhenologyMetadata } from "../types/phenology";
import { phenologyProbabilityAt } from "../utils/phenologyUtils";

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

type DatasetPhenologyDate = {
  id: number;
  aquisition_year?: number | string | null;
  aquisition_month?: number | string | null;
  aquisition_day?: number | string | null;
  /** computed server-side in the dataset views (phenology_probability_at) */
  phenology_probability?: number | null;
};

/** A dataset's phenology curve and the probability that it was taken in the maximum greenness
 * period: the views' value, else worked out from the curve and the acquisition date. */
export function useDatasetPhenology(dataset: DatasetPhenologyDate) {
  const { data: phenology, isLoading } = usePhenologyData(dataset.id);
  const probability =
    dataset.phenology_probability ??
    phenologyProbabilityAt(phenology?.phenology_curve, dataset.aquisition_year, dataset.aquisition_month, dataset.aquisition_day);
  return { phenology, isLoading, probability };
}
