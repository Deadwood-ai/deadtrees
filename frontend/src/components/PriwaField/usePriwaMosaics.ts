import { useQuery } from "@tanstack/react-query";

import { supabase } from "../../hooks/useSupabase";

export interface IPriwaMosaic {
  id: string;
  projectId: string;
  label: string;
  cogUrl: string;
  captureDate: string | null;
}

interface IPriwaMosaicRow {
  id: string;
  project_id: string;
  label: string;
  cog_url: string;
  capture_date: string | null;
}

export const priwaMosaicsQueryKey = (
  projectId: string | null | undefined,
) => ["priwa-project-mosaics", projectId];

export const fetchPriwaMosaics = async (
  projectId: string,
): Promise<IPriwaMosaic[]> => {
  const { data, error } = await supabase
    .from("priwa_project_mosaics")
    .select("id, project_id, label, cog_url, capture_date")
    .eq("project_id", projectId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("capture_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (error) throw error;

  return ((data ?? []) as IPriwaMosaicRow[]).map((row) => ({
    id: row.id,
    projectId: row.project_id,
    label: row.label,
    cogUrl: row.cog_url,
    captureDate: row.capture_date,
  }));
};

export function usePriwaMosaics(projectId: string | null | undefined) {
  return useQuery({
    queryKey: priwaMosaicsQueryKey(projectId),
    enabled: !!projectId,
    queryFn: () => fetchPriwaMosaics(projectId as string),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 1,
  });
}
