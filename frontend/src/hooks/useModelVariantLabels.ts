import { useQuery } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { ILabel, ILabelData, ILabelSource } from "../types/labels";
import { Settings } from "../config";

export function useModelVariantLabels(datasetId: number | undefined, labelData: ILabelData, enabled = true) {
  return useQuery({
    queryKey: ["modelVariantLabels", datasetId, labelData],
    queryFn: async (): Promise<ILabel[]> => {
      if (!datasetId) return [];
      const { data, error } = await supabase
        .from(Settings.LABELS_TABLE)
        .select("*")
        .eq("dataset_id", datasetId)
        .eq("label_data", labelData)
        .eq("label_source", ILabelSource.MODEL_PREDICTION)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as ILabel[];
    },
    enabled: enabled && !!datasetId,
  });
}
