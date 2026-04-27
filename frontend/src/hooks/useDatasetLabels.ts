import { useQuery } from "@tanstack/react-query";
import { supabase } from "../hooks/useSupabase";
import { ILabel, ILabelData } from "../types/labels";
import { Settings } from "../config";

interface UseDatasetLabelsProps {
  datasetId: number;
  labelData?: ILabelData;
  enabled?: boolean;
}

interface ModelPreference {
  label_data: string;
  model_config: Record<string, unknown>;
}

function useModelPreferences() {
  return useQuery({
    queryKey: ["model-preferences"],
    queryFn: async (): Promise<Map<string, Record<string, unknown>>> => {
      const { data, error } = await supabase
        .from("v2_model_preferences")
        .select("label_data,model_config");
      if (error) {
        console.error("Error fetching model preferences:", error);
        return new Map();
      }
      return new Map((data as ModelPreference[]).map((row) => [row.label_data, row.model_config]));
    },
    staleTime: 5 * 60 * 1000,
  });
}

function configMatches(
  labelConfig: Record<string, unknown> | undefined,
  preferredConfig: Record<string, unknown>,
): boolean {
  if (!labelConfig) return false;
  return Object.entries(preferredConfig).every(([k, v]) => labelConfig[k] === v);
}

export function useDatasetLabels({
  datasetId,
  labelData: labelType = ILabelData.DEADWOOD,
  enabled = true,
}: UseDatasetLabelsProps) {
  const { data: preferences } = useModelPreferences();

  return useQuery({
    queryKey: ["labels", datasetId, labelType, preferences ? "prefs-loaded" : "prefs-pending"],
    queryFn: async (): Promise<ILabel | null> => {
      if (!datasetId) return null;

      const query = supabase.from(Settings.LABELS_TABLE).select("*").eq("dataset_id", datasetId);

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

      if (data.length === 1) {
        return data[0];
      }

      // Prefer the model_prediction label whose model_config matches v2_model_preferences.
      const preferredConfig = labelType ? preferences?.get(labelType) : undefined;
      if (preferredConfig) {
        const preferred = data.find(
          (label) =>
            label.label_source === "model_prediction" &&
            configMatches(label.model_config, preferredConfig),
        );
        if (preferred) return preferred;
      }

      // Fall back to any model_prediction, then first label.
      return data.find((label) => label.label_source === "model_prediction") ?? data[0];
    },
    enabled,
  });
}
