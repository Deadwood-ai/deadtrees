import { useQuery } from "@tanstack/react-query";
import { Settings } from "../config";
import { fixTextEncoding } from "../utils/textUtils";
import { useAuth } from "./useAuthProvider";
import { supabase } from "./useSupabase";

export interface IHomeStats {
  dataset_count: number;
  country_count: number;
  contributor_count: number;
  area_covered_ha: number;
  data_size_tb: number;
  contributor_names: string[];
}

export interface IHomeDatasetTeaser {
  id: number;
  authors: string[] | null;
  aquisition_year: number | null;
  aquisition_month: number | null;
  aquisition_day: number | null;
  platform: string | null;
  thumbnail_path: string | null;
  admin_level_1: string | null;
  admin_level_2: string | null;
  admin_level_3: string | null;
}

const HOME_DATASET_TEASER_FIELDS = [
  "id",
  "authors",
  "aquisition_year",
  "aquisition_month",
  "aquisition_day",
  "platform",
  "thumbnail_path",
  "admin_level_1",
  "admin_level_2",
  "admin_level_3",
].join(",");

const HOME_STATS_FIELDS = [
  "dataset_count",
  "country_count",
  "contributor_count",
  "area_covered_ha",
  "data_size_tb",
  "contributor_names",
].join(",");

const normalizeContributorNames = (names: string[]) => {
  const seen = new Set<string>();

  return names
    .map((author) => fixTextEncoding(author).replace(/\s+/g, " ").trim())
    .filter((author) => {
      if (!author || seen.has(author)) {
        return false;
      }

      seen.add(author);
      return true;
    })
    .sort((a, b) => a.localeCompare(b));
};

const normalizeHomeStats = (stats: IHomeStats | null): IHomeStats | null => {
  if (!stats) return stats;

  const contributor_names = normalizeContributorNames(stats.contributor_names || []);

  return {
    ...stats,
    contributor_count: contributor_names.length,
    contributor_names,
  };
};

export function useHomeStats() {
  const { status } = useAuth();

  return useQuery({
    queryKey: ["home-stats"],
    enabled: status !== "checking",
    queryFn: async () => {
      const { data, error } = await supabase
        .from(Settings.HOME_STATS_VIEW)
        .select(HOME_STATS_FIELDS)
        .maybeSingle();

      if (error) throw error;

      return normalizeHomeStats(data as unknown as IHomeStats | null);
    },
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}

export function useHomeDatasetTeasers(limit = 64) {
  const { status } = useAuth();

  return useQuery({
    queryKey: ["home-dataset-teasers", limit],
    enabled: status !== "checking",
    queryFn: async () => {
      const { data, error } = await supabase
        .from(Settings.HOME_DATASET_TEASERS_VIEW)
        .select(HOME_DATASET_TEASER_FIELDS)
        .order("id", { ascending: false })
        .limit(limit);

      if (error) throw error;

      return data as unknown as IHomeDatasetTeaser[];
    },
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}
