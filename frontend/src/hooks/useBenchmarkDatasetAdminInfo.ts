import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { Settings } from "../config";
import { supabase } from "./useSupabase";
import {
  dteAerialBenchmarkDatasetAdminInfoById,
  type BenchmarkDatasetAdminInfo,
  type BenchmarkDatasetCollection,
} from "../data/benchmarkDatasets";

export function useBenchmarkDatasetAdminInfo(
  collection: BenchmarkDatasetCollection,
) {
  const datasetIds = useMemo(
    () => collection.sites.map((site) => site.id),
    [collection.sites],
  );

  const { data: adminInfoRows, isLoading } = useQuery({
    queryKey: [
      "benchmark-dataset-admin-info",
      collection.slug,
      datasetIds.join(","),
    ],
    queryFn: async () => {
      const { data, error } = await supabase
        .from(Settings.DATA_TABLE_PUBLIC)
        .select(
          "id, admin_level_1, admin_level_2, admin_level_3, aquisition_year, aquisition_month, aquisition_day, platform, authors",
        )
        .in("id", datasetIds);

      if (error) throw error;
      return (data ?? []) as BenchmarkDatasetAdminInfo[];
    },
    staleTime: 5 * 60 * 1000,
  });

  const adminInfoByDatasetId = useMemo(() => {
    const rowsById = new Map<number, BenchmarkDatasetAdminInfo>(
      Object.entries(dteAerialBenchmarkDatasetAdminInfoById).map(
        ([id, adminInfo]) => [Number(id), adminInfo],
      ),
    );
    adminInfoRows?.forEach((row) => rowsById.set(Number(row.id), row));
    return rowsById;
  }, [adminInfoRows]);

  return {
    adminInfoByDatasetId,
    isAdminInfoLoading: isLoading,
  };
}
