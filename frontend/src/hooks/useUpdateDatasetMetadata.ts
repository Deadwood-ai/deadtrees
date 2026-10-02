import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { useAuth } from "./useAuthProvider";

export interface UpdateDatasetMetadataPayload {
  dataset_id: number;
  authors?: string[];
  aquisition_year?: number;
  aquisition_month?: number | null;
  aquisition_day?: number | null;
  platform?: string;
  citation_doi?: string;
  additional_information?: string;
}

export function useUpdateDatasetMetadata() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: UpdateDatasetMetadataPayload) => {
      const { dataset_id, ...details } = payload;

      // The database checks that the caller owns the dataset or holds an Editor or
      // Admin grant, and changes only these descriptive fields.
      const { data, error } = await supabase.rpc("update_dataset_details", {
        p_dataset_id: dataset_id,
        p_details: details,
      });

      if (error) {
        console.error("Update error:", error);
        throw error;
      }

      //   console.log("Update successful:", data);
      return data;
    },
    onSuccess: (_data, payload) => {
      queryClient.invalidateQueries({ queryKey: ["datasets", payload.dataset_id] });

      // Invalidate only the user's datasets (not global datasets)
      queryClient.invalidateQueries({
        queryKey: ["userDatasets", user?.id],
      });

      // Also invalidate authors list in case new authors were added
      queryClient.invalidateQueries({
        queryKey: ["authors"],
      });
    },
    onError: (error) => {
      console.error("Error updating dataset metadata:", error);
    },
  });
}
