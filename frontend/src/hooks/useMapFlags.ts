import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { useAuth } from "./useAuthProvider";
import { useCanAudit } from "./useUserPrivileges";
import type { IMapFlag, CreateMapFlagInput } from "../types/mapFlags";

/**
 * Fetch map flags - regular users see only their own, auditors see all
 */
export function useMapFlags() {
  const { user } = useAuth();
  const { canAudit } = useCanAudit();

  return useQuery({
    queryKey: ["map-flags", user?.id, canAudit],
    enabled: !!user?.id,
    queryFn: async (): Promise<IMapFlag[]> => {
      if (!user?.id) return [];

      // RLS handles the filtering - auditors see all, regular users see own
      const { data, error } = await supabase.from("map_flags").select("*").order("created_at", { ascending: false });

      if (error) throw error;
      return (data ?? []) as IMapFlag[];
    },
    staleTime: 60_000,
  });
}

/**
 * Create a new map flag
 */
export function useCreateMapFlag() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (input: CreateMapFlagInput): Promise<IMapFlag> => {
      if (!user?.id) throw new Error("Not authenticated");

      const { data, error } = await supabase
        .from("map_flags")
        .insert({
          created_by: user.id,
          bbox: input.bbox,
          description: input.description,
          category: input.category ?? "other",
          year: input.year ?? null,
        })
        .select("*")
        .single();

      if (error) throw error;
      return data as IMapFlag;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["map-flags"] });
    },
  });
}

/**
 * Delete a map flag (users can only delete their own via RLS)
 */
export function useDeleteMapFlag() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (flagId: number): Promise<void> => {
      const { error } = await supabase.from("map_flags").delete().eq("id", flagId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["map-flags"] });
    },
  });
}

