import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { useAuth } from "./useAuthProvider";
import { useProcessingNotification } from "./useProcessingNotification";

interface StatusPayloadData {
  dataset_id: number;
  current_status: string;
  is_upload_done: boolean;
  is_odm_done?: boolean;
  is_ortho_done: boolean;
  is_cog_done: boolean;
  is_thumbnail_done: boolean;
  is_metadata_done: boolean;
  is_deadwood_done: boolean;
  is_forest_cover_done: boolean;
  has_error: boolean;
  error_message?: string;
}

export function useDatasetSubscription() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const { showProcessingCompleteNotification, showProcessingErrorNotification } = useProcessingNotification();

  useEffect(() => {
    const channel = supabase
      .channel("status_changes")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "v2_statuses",
        },
        async (payload) => {
          const statusData = payload.new as StatusPayloadData;
          const oldStatusData = payload.old as StatusPayloadData;

          // Get dataset info from the dataset_id
          if (!statusData?.dataset_id) {
            return;
          }

          try {
            // Fetch the dataset info to get user_id and file_name
            const { data: datasetInfo, error } = await supabase
              .from("v2_datasets")
              .select("user_id, file_name")
              .eq("id", statusData.dataset_id)
              .single();

            if (error || !datasetInfo) {
              return;
            }

            // Check if this is the current user's dataset
            if (session?.user?.id !== datasetInfo.user_id) {
              // Still invalidate queries for progress tracking
              await queryClient.invalidateQueries({
                queryKey: ["userDatasets", session?.user?.id],
              });
              return;
            }

            // Helper function to check if processing is complete
            const isProcessingComplete = (data: StatusPayloadData | null): boolean => {
              if (!data) return false;

              // Check if ODM step is required (presence of is_odm_done field)
              const odmComplete = data.is_odm_done === undefined || data.is_odm_done;

              return (
                data.is_upload_done &&
                odmComplete &&
                data.is_ortho_done &&
                data.is_cog_done &&
                data.is_thumbnail_done &&
                data.is_metadata_done &&
                data.is_deadwood_done &&
                data.is_forest_cover_done
              );
            };

            // Check if processing just completed (was incomplete before, now complete)
            const wasProcessingComplete = isProcessingComplete(oldStatusData);
            const isNowProcessingComplete = isProcessingComplete(statusData);

            // Check if processing just failed
            const hadError = oldStatusData && oldStatusData.has_error;
            const hasErrorNow = statusData && statusData.has_error;

            // Always update user datasets for progress tracking
            await queryClient.invalidateQueries({
              queryKey: ["userDatasets", session?.user?.id],
            });

            // Show completion notification if processing just completed
            if (!wasProcessingComplete && isNowProcessingComplete) {
              showProcessingCompleteNotification(datasetInfo.file_name || "Dataset", statusData.dataset_id);
            }

            // Show error notification if processing just failed
            if (!hadError && hasErrorNow) {
              showProcessingErrorNotification(datasetInfo.file_name || "Dataset", statusData.error_message);
            }

            // Only update global datasets and authors when processing is complete
            if (isNowProcessingComplete) {
              await queryClient.invalidateQueries({
                queryKey: ["datasets"],
              });
              await queryClient.invalidateQueries({
                queryKey: ["public-datasets"],
              });
              await queryClient.invalidateQueries({
                queryKey: ["authors"],
              });
            }
          } catch (error) {
            console.error("Error in dataset subscription handler:", error);
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient, session, showProcessingCompleteNotification, showProcessingErrorNotification]);
}
