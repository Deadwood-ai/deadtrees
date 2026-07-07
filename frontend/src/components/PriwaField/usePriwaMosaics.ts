import { useQuery } from "@tanstack/react-query";

import { Settings } from "../../config";
import { supabase } from "../../hooks/useSupabase";

export interface IPriwaMosaic {
  id: string;
  projectId: string;
  label: string;
  cogUrl: string;
  captureDate: string | null;
  createdAt: string;
  authors: string[];
  additionalInformation: string | null;
}

interface IPriwaMosaicRow {
  id: string;
  project_id: string;
  label: string;
  cog_url: string;
  capture_date: string | null;
  created_at: string;
  authors: string[] | null;
  additional_information: string | null;
}

interface IPriwaDatasetMosaicRow {
  id: number;
  file_name: string | null;
  cog_path: string | null;
  aquisition_year: number | null;
  aquisition_month: number | null;
  aquisition_day: number | null;
  created_at: string;
  authors: string[] | null;
  additional_information: string | null;
}

const PRIWA_MOSAIC_LIMIT = 50;
const PRIWA_PREVIEW_AUTHOR_MARKERS = new Set([
  "prima",
  "prima-wald",
  "priwa",
  "unique land use",
  "unique land use gmbh",
]);

const isMissingPriwaMosaicRpc = (error: unknown) => {
  const candidate = error as { code?: string; message?: string } | null;
  return (
    candidate?.code === "PGRST202" ||
    candidate?.message?.includes("priwa_project_latest_flight_mosaics") === true
  );
};

const hasPriwaPreviewAuthor = (authors: string[] | null) =>
  (authors ?? []).some((author) =>
    PRIWA_PREVIEW_AUTHOR_MARKERS.has(author.trim().toLowerCase()),
  );

const dateFromAcquisitionParts = (row: IPriwaDatasetMosaicRow) => {
  if (!row.aquisition_year || !row.aquisition_month || !row.aquisition_day) {
    return null;
  }

  const date = new Date(
    Date.UTC(row.aquisition_year, row.aquisition_month - 1, row.aquisition_day),
  );
  if (
    date.getUTCFullYear() !== row.aquisition_year ||
    date.getUTCMonth() !== row.aquisition_month - 1 ||
    date.getUTCDate() !== row.aquisition_day
  ) {
    return null;
  }

  return date.toISOString().slice(0, 10);
};

const fetchPreviewFallbackMosaics = async (
  projectId: string,
): Promise<IPriwaMosaic[]> => {
  const { data, error } = await supabase
    .from(Settings.DATA_TABLE_PUBLIC)
    .select(
      "id, file_name, cog_path, aquisition_year, aquisition_month, aquisition_day, created_at, authors, additional_information",
    )
    .eq("platform", "drone")
    .eq("is_cog_done", true)
    .not("cog_path", "is", null)
    .order("created_at", { ascending: false })
    .limit(300);

  if (error) throw error;

  return ((data ?? []) as IPriwaDatasetMosaicRow[])
    .filter((row) => row.cog_path && hasPriwaPreviewAuthor(row.authors))
    .slice(0, PRIWA_MOSAIC_LIMIT)
    .map((row) => ({
      id: String(row.id),
      projectId,
      label: row.file_name || `Dataset ${row.id}`,
      cogUrl: row.cog_path as string,
      captureDate: dateFromAcquisitionParts(row),
      createdAt: row.created_at,
      authors: row.authors ?? [],
      additionalInformation: row.additional_information,
    }));
};

export const priwaMosaicsQueryKey = (
  projectId: string | null | undefined,
) => ["priwa-project-mosaics", projectId];

export const fetchPriwaMosaics = async (
  projectId: string,
): Promise<IPriwaMosaic[]> => {
  const { data, error } = await supabase
    .rpc("priwa_project_latest_flight_mosaics", {
      p_project_id: projectId,
      p_limit: PRIWA_MOSAIC_LIMIT,
    });

  if (error) {
    if (isMissingPriwaMosaicRpc(error)) {
      return fetchPreviewFallbackMosaics(projectId);
    }

    throw error;
  }

  return ((data ?? []) as IPriwaMosaicRow[]).map((row) => ({
    id: row.id,
    projectId: row.project_id,
    label: row.label,
    cogUrl: row.cog_url,
    captureDate: row.capture_date,
    createdAt: row.created_at,
    authors: row.authors ?? [],
    additionalInformation: row.additional_information,
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
