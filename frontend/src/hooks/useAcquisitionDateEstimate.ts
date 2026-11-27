import { useQuery } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import type { IAcquisitionDateDecision, IAcquisitionDateEstimate } from "../types/acquisitionDate";
import type { IGeorefCheck } from "../types/georefCheck";

/** The dataset's acquisition-date estimate (null until the stage has run). */
export function useAcquisitionDateEstimate(datasetId: number | undefined) {
  return useQuery({
    queryKey: ["acquisition-date-estimate", datasetId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v2_acquisition_date_estimates")
        .select("*")
        .eq("dataset_id", datasetId!)
        .maybeSingle();
      if (error) throw error;
      return (data as IAcquisitionDateEstimate | null) ?? null;
    },
    enabled: !!datasetId,
    staleTime: 5 * 60 * 1000,
  });
}

/** The dataset's earlier date decisions (history, no new ones are written), newest first; the active one has no superseded_at. */
export function useAcquisitionDateDecisions(datasetId: number | undefined) {
  return useQuery({
    queryKey: ["acquisition-date-decisions", datasetId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("acquisition_date_decisions")
        .select("*")
        .eq("dataset_id", datasetId!)
        .order("decided_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data as IAcquisitionDateDecision[]) ?? [];
    },
    enabled: !!datasetId,
    staleTime: 5 * 60 * 1000,
  });
}

/** The dataset's georeferencing check (null until the stage has run). */
export function useGeorefCheck(datasetId: number | undefined) {
  return useQuery({
    queryKey: ["georef-check", datasetId],
    queryFn: async () => {
      const { data, error } = await supabase.from("v2_georef_checks").select("*").eq("dataset_id", datasetId!).maybeSingle();
      if (error) throw error;
      return (data as IGeorefCheck | null) ?? null;
    },
    enabled: !!datasetId,
    staleTime: 5 * 60 * 1000,
  });
}
