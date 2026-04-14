import { useQuery } from "@tanstack/react-query";
import { useAuth } from "./useAuthProvider";
import { supabase } from "./useSupabase";
import { Settings } from "../config";
import { IDataset } from "../types/dataset";
import { fixTextEncoding } from "../utils/textUtils";

interface DatasetQueryOptions {
  enabled?: boolean;
}

// Base datasets hook - includes ALL datasets (for admin/audit use)
export function useDatasets(options: DatasetQueryOptions = {}) {
  return useQuery({
    queryKey: ["datasets"],
    queryFn: async () => {
      const { data, error } = await supabase.from(Settings.DATA_TABLE_FULL).select("*");
      if (error) throw error;
      return data;
    },
    enabled: options.enabled ?? true,
    staleTime: 5 * 60 * 1000, // 5 minutes - data is fresh for 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes - keep in cache for 10 minutes
  });
}

// Public datasets hook - excludes datasets marked as "exclude_completely"
export function usePublicDatasets(options: DatasetQueryOptions = {}) {
  return useQuery({
    queryKey: ["public-datasets"],
    queryFn: async () => {
      const { data, error } = await supabase.from(Settings.DATA_TABLE_PUBLIC).select("*");
      if (error) throw error;
      return data;
    },
    enabled: options.enabled ?? true,
    staleTime: 5 * 60 * 1000, // 5 minutes - data is fresh for 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes - keep in cache for 10 minutes
  });
}

// Public single dataset hook - optimized for dataset details page
export function usePublicDatasetById(datasetId: number | undefined) {
	return useQuery({
		queryKey: ["public-dataset-by-id", datasetId],
		enabled: !!datasetId,
		queryFn: async () => {
			if (!datasetId) return null;
			const { data, error } = await supabase
				.from(Settings.DATA_TABLE_PUBLIC)
				.select("*")
				.eq("id", datasetId)
				.maybeSingle();
			if (error) throw error;
			return (data as IDataset | null) ?? null;
		},
		staleTime: 5 * 60 * 1000,
		gcTime: 10 * 60 * 1000,
	});
}

// Fetch a single dataset by id; minimal fields are enough for Tiles page
export function useDatasetById(datasetId: number | undefined) {
  return useQuery({
    queryKey: ["dataset-by-id", datasetId],
    enabled: !!datasetId,
    queryFn: async () => {
      if (!datasetId) return null;
      const { data, error } = await supabase.from(Settings.DATA_TABLE_FULL).select("*").eq("id", datasetId).single();
      if (error) throw error;
      return data as IDataset;
    },
  });
}

// User-specific datasets - uses public view to exclude excluded and archived datasets
export function useUserDatasets(options: DatasetQueryOptions = {}) {
  const { session } = useAuth();

  return useQuery({
    queryKey: ["userDatasets", session?.user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from(Settings.DATA_TABLE_PUBLIC)
        .select("*")
        .eq("user_id", session?.user.id)
        .eq("archived", false);
      if (error) throw error;
      return data;
    },
    enabled: (options.enabled ?? true) && !!session?.user?.id,
    staleTime: 5 * 60 * 1000, // 5 minutes - data is fresh for 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes - keep in cache for 10 minutes
  });
}

// Authors list - based on public datasets only
export function useAuthors(options: DatasetQueryOptions = {}) {
  const { data: datasets } = usePublicDatasets({ enabled: options.enabled });

  return useQuery({
    queryKey: ["authors"],
    enabled: (options.enabled ?? true) && !!datasets,
    queryFn: () => {
      // Flatten all authors arrays and remove duplicates
      const allAuthors = datasets
        ?.flatMap((item) => item.authors || [])
        .filter(Boolean)
        .map((author) => fixTextEncoding(author).replace(/\s+/g, " ").trim())
        .filter(Boolean);

      const authorsUnique = [...new Set(allAuthors)].sort((a, b) => a.localeCompare(b));

      return authorsUnique.map((author) => ({
        label: author,
        value: author,
      }));
    },
  });
}
