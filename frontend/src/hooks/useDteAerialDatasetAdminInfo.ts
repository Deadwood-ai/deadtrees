import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { Settings } from "../config";
import { supabase } from "./useSupabase";
import {
  dteAerialDatasetAdminInfoById,
  type DteAerialDatasetAdminInfo,
  type DteAerialRelease,
} from "../data/releases";

export function useDteAerialDatasetAdminInfo(release: DteAerialRelease) {
  const sites = release.dteAerial.sites;
  const datasetIds = useMemo(
    () => sites.map((site) => site.id),
    [sites],
  );

  const { data: adminInfoRows, isLoading } = useQuery({
    queryKey: [
      "dte-aerial-release-dataset-admin-info",
      release.slug,
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
      return (data ?? []) as DteAerialDatasetAdminInfo[];
    },
    staleTime: 5 * 60 * 1000,
  });

  const adminInfoByDatasetId = useMemo(() => {
    const rowsById = new Map<number, DteAerialDatasetAdminInfo>(
      Object.entries(dteAerialDatasetAdminInfoById).map(
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
