import { useQuery } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { IDataset } from "../types/dataset";
import { Settings } from "../config";

interface OverlappingDataset {
  dataset_id: number;
  overlap_ratio: number;
}

export function useOverlappingDatasets(datasetId: number | undefined) {
  const query = useQuery({
    queryKey: ["overlappingDatasets", datasetId],
    queryFn: async (): Promise<IDataset[]> => {
      if (!datasetId) {
        return [];
      }

      try {
        // Call the database function to get overlapping dataset IDs
        const { data, error } = await supabase.rpc("find_overlapping_datasets", {
          input_dataset_id: datasetId,
          overlap_threshold: 0.4,
        });

        if (error) {
          console.error("Error fetching overlapping datasets:", error);
          return [];
        }

        if (!data || data.length === 0) {
          return [];
        }

        // Include the current dataset in the list for proper navigation
        const datasetIds = new Set([datasetId, ...(data as OverlappingDataset[]).map((item) => item.dataset_id)]);

        const ids = Array.from(datasetIds);
        if (ids.length === 0) return [];

        // Fetch only overlapping datasets instead of loading all datasets and filtering client-side.
        const { data: datasets, error: datasetsError } = await supabase
          .from(Settings.DATA_TABLE_PUBLIC)
          .select("*")
          .in("id", ids);

        if (datasetsError || !datasets) {
          if (datasetsError) {
            console.error("Error fetching overlapping dataset details:", datasetsError);
          }
          return [];
        }

        const overlappingDatasets = datasets as IDataset[];

        // Sort by acquisition date
        return overlappingDatasets.sort((a, b) => {
          const aYear = parseInt(String(a.aquisition_year || ""), 10);
          const bYear = parseInt(String(b.aquisition_year || ""), 10);
          const aMonth = parseInt(String(a.aquisition_month || ""), 10);
          const bMonth = parseInt(String(b.aquisition_month || ""), 10);
          const aDay = parseInt(String(a.aquisition_day || ""), 10);
          const bDay = parseInt(String(b.aquisition_day || ""), 10);

          const dateA = new Date(
            Number.isNaN(aYear) ? 1970 : aYear,
            Number.isNaN(aMonth) ? 0 : Math.max(0, aMonth - 1),
            Number.isNaN(aDay) ? 1 : aDay,
          );
          const dateB = new Date(
            Number.isNaN(bYear) ? 1970 : bYear,
            Number.isNaN(bMonth) ? 0 : Math.max(0, bMonth - 1),
            Number.isNaN(bDay) ? 1 : bDay,
          );
          return dateA.getTime() - dateB.getTime();
        });
      } catch (err) {
        console.error("Error in overlapping datasets query:", err);
        return [];
      }
    },
    enabled: !!datasetId,
    staleTime: 5 * 60 * 1000, // 5 minutes cache
  });

  return query;
}
