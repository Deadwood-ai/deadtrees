import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "../../hooks/useSupabase";
import type {
  IPriwaBefallsgruppe,
  IPriwaBefallsgruppeSaveInput,
  PriwaBefallsgruppeOrigin,
} from "./types";

interface IPriwaBefallsgruppeRow {
  id: string;
  project_id: string;
  name: string;
  origin: PriwaBefallsgruppeOrigin;
  confidence: number | null;
  suggestion_reason: string | null;
  algorithm_version: string | null;
  created_at: string;
  updated_at: string;
  priwa_befallsgruppe_members: Array<{
    tree_id: string;
    source: PriwaBefallsgruppeOrigin;
  }> | null;
  priwa_befallsgruppe_flights: Array<{
    dataset_id: number;
    source: PriwaBefallsgruppeOrigin;
  }> | null;
}

export const priwaBefallsgruppenQueryKey = (
  projectId: string | null | undefined,
) => ["priwa-befallsgruppen", projectId];

export const fetchPriwaBefallsgruppen = async (
  projectId: string,
): Promise<IPriwaBefallsgruppe[]> => {
  const { data, error } = await supabase
    .from("priwa_befallsgruppen")
    .select(
      "id, project_id, name, origin, confidence, suggestion_reason, algorithm_version, created_at, updated_at, priwa_befallsgruppe_members(tree_id, source), priwa_befallsgruppe_flights(dataset_id, source)",
    )
    .eq("project_id", projectId)
    .order("updated_at", { ascending: false });

  if (error) throw error;

  return ((data ?? []) as IPriwaBefallsgruppeRow[]).map((row) => ({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    origin: row.origin,
    confidence: row.confidence,
    suggestionReason: row.suggestion_reason,
    algorithmVersion: row.algorithm_version,
    treeIds: (row.priwa_befallsgruppe_members ?? [])
      .map((member) => member.tree_id)
      .sort(),
    datasetIds: (row.priwa_befallsgruppe_flights ?? [])
      .map((flight) => String(flight.dataset_id))
      .sort((left, right) =>
        left.localeCompare(right, undefined, { numeric: true }),
      ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
};

export const savePriwaBefallsgruppe = async (
  projectId: string,
  input: IPriwaBefallsgruppeSaveInput,
) => {
  const datasetIds = input.datasetIds.map((id) => Number(id));
  if (datasetIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("Eine ausgewählte Umfeldbefliegung hat keine gültige ID.");
  }

  const { data, error } = await supabase.rpc("priwa_save_befallsgruppe", {
    p_project_id: projectId,
    p_name: input.name,
    p_tree_ids: input.treeIds,
    p_dataset_ids: datasetIds,
    p_group_id: input.id ?? null,
    p_origin: input.origin,
    p_confidence: input.confidence ?? null,
    p_suggestion_reason: input.suggestionReason ?? null,
    p_algorithm_version: input.algorithmVersion ?? null,
  });

  if (error) throw error;
  return data as string;
};

export const deletePriwaBefallsgruppe = async (groupId: string) => {
  const { error } = await supabase
    .from("priwa_befallsgruppen")
    .delete()
    .eq("id", groupId);

  if (error) throw error;
};

export function usePriwaBefallsgruppen(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: priwaBefallsgruppenQueryKey(projectId),
    enabled: !!projectId,
    queryFn: () => fetchPriwaBefallsgruppen(projectId as string),
    staleTime: 30 * 1000,
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: priwaBefallsgruppenQueryKey(projectId),
    });
  };

  const saveMutation = useMutation({
    mutationFn: async (input: IPriwaBefallsgruppeSaveInput) => {
      if (!projectId) throw new Error("PRIWA Projekt ist nicht verfügbar.");
      return savePriwaBefallsgruppe(projectId, input);
    },
    onSuccess: invalidate,
  });
  const deleteMutation = useMutation({
    mutationFn: deletePriwaBefallsgruppe,
    onSuccess: invalidate,
  });

  return {
    groups: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    saveGroup: saveMutation.mutateAsync,
    deleteGroup: deleteMutation.mutateAsync,
    isSaving: saveMutation.isPending || deleteMutation.isPending,
  };
}
