import { useQuery } from "@tanstack/react-query";
import { supabase } from "../hooks/useSupabase";
import { ILabel, ILabelData } from "../types/labels";
import { Settings } from "../config";
import {
  ModelPreferenceConfig,
  selectPreferredModelLabel,
} from "../utils/modelPreferences";

interface UseDatasetLabelsProps {
  datasetId: number;
  labelData?: ILabelData;
  enabled?: boolean;
}

interface ModelPreference {
  label_data: string;
  model_config: ModelPreferenceConfig;
}

function useModelPreferences() {
  return useQuery({
    queryKey: ["model-preferences"],
    queryFn: async (): Promise<Map<string, ModelPreferenceConfig>> => {
      const { data, error } = await supabase
        .from("v2_model_preferences")
        .select("label_data,model_config");
      if (error) {
        console.error("Error fetching model preferences:", error);
        return new Map();
      }
      return new Map(
        (data as ModelPreference[]).map((row) => [
          row.label_data,
          row.model_config,
        ]),
      );
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useDatasetLabels({
  datasetId,
  labelData: labelType = ILabelData.DEADWOOD,
  enabled = true,
}: UseDatasetLabelsProps) {
  const { data: preferences } = useModelPreferences();

  return useQuery({
    queryKey: [
      "labels",
      datasetId,
      labelType,
      preferences ? "prefs-loaded" : "prefs-pending",
    ],
    queryFn: async (): Promise<ILabel | null> => {
      if (!datasetId) return null;

      const query = supabase
        .from(Settings.LABELS_TABLE)
        .select("*")
        .eq("dataset_id", datasetId)
        .eq("is_active", true);

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

      return selectPreferredModelLabel(
        data as ILabel[],
        labelType,
        preferences,
      );
    },
    enabled,
  });
}
