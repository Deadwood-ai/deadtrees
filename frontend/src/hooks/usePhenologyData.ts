import { useQuery } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { PhenologyMetadata } from "../types/phenology";
import { type AcquisitionDateParts, phenologyDate, phenologyProbabilityAt } from "../utils/phenologyUtils";
import { useDatasetAuditSummary } from "./useDatasetAuditSummary";

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

type DatasetPhenologyDate = AcquisitionDateParts & {
  id: number;
  /** computed server-side in the dataset views (phenology_probability_at), at the reported date */
  phenology_probability?: number | null;
};

/** A dataset's phenology curve, the date it is read at and the probability that the image was
 * taken in the maximum greenness period. Where the audit replaces the reported date, both follow
 * the new date; else the views' value, or the curve at the reported date. */
export function useDatasetPhenology(dataset: DatasetPhenologyDate) {
  const { data: phenology, isLoading } = usePhenologyData(dataset.id);
  const { data: audit } = useDatasetAuditSummary(dataset.id);
  const date = phenologyDate(dataset, audit?.date_new);
  const probability =
    (audit?.date_new ? null : dataset.phenology_probability) ??
    phenologyProbabilityAt(phenology?.phenology_curve, date.aquisition_year, date.aquisition_month, date.aquisition_day);
  return { phenology, isLoading, probability, date };
}
