import { Settings } from "../../config";
import { ILabels } from "../../types/dataset";
import { supabase } from "../../hooks/useSupabase";

const fetchLabels = async ({ dataset_id }: { dataset_id: number }): Promise<ILabels | null> => {
  console.debug("dataset_id", dataset_id);
  const { data, error } = await supabase.from(Settings.LABELS_TABLE).select("*").eq("dataset_id", dataset_id);

  if (error) {
    // console.error("Error fetching data:", error);
    return null;
  } else {
    // console.debug("Data fetched:", data);

    if (!data || data.length === 0) {
      return null;
    }

    // If multiple labels exist, prioritize 'model_prediction'
    if (data.length > 1) {
      const modelPrediction = data.find((label) => label.label_source === "model_prediction");
      return modelPrediction || data[0];
    }

    return data[0];
  }
};

export default fetchLabels;
