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
      const { dataset_id, ...updateData } = payload;

      // Update the dataset metadata in v2_datasets table
      // Note: RLS policy handles authorization, so we don't need .eq("user_id", user?.id)
      const { data, error } = await supabase
        .from("v2_datasets")
        .update(updateData)
        .eq("id", dataset_id)
        .select()
        .single();

      if (error) {
        console.error("Update error:", error);
        throw error;
      }

      //   console.log("Update successful:", data);
      return data;
    },
    onSuccess: () => {
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
