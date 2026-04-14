import { useQuery } from "@tanstack/react-query";
import { supabase } from "../hooks/useSupabase";
import { ILabel, ILabelData } from "../types/labels";
import { Settings } from "../config";

interface UseDatasetLabelsProps {
  datasetId: number;
  labelData?: ILabelData;
  enabled?: boolean;
}

export function useDatasetLabels({
  datasetId,
  labelData: labelType = ILabelData.DEADWOOD,
  enabled = true,
}: UseDatasetLabelsProps) {
  return useQuery({
    queryKey: ["labels", datasetId, labelType],
    queryFn: async (): Promise<ILabel | null> => {
      if (!datasetId) return null;

      const query = supabase.from(Settings.LABELS_TABLE).select("*").eq("dataset_id", datasetId);

      // Add label type filter if provided
      if (labelType) {
        query.eq("label_data", labelType);
      }

      const { data, error } = await query;

      if (error) {
        console.error("Error fetching label data:", error);
        return null;
      }

      if (!data || data.length === 0) {
        return null;
      }

      // If multiple labels exist, prioritize 'model_prediction'
      if (data.length > 1) {
        const modelPrediction = data.find((label) => label.label_source === "model_prediction");
        return modelPrediction || data[0];
      }

      return data[0];
    },
    enabled,
  });
}
