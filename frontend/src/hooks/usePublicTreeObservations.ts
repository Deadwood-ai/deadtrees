import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "./useSupabase";
import type {
  PublicTreeCondition,
  PublicTreeObservation,
  PublicTreeObservationInput,
  PublicTreeTypeGroup,
} from "../types/publicTreeObservations";

interface PublicTreeGeometryPoint {
  type: "Point";
  coordinates: [number, number];
}

interface PublicTreeObservationRow {
  id: string;
  geom: PublicTreeGeometryPoint | string | null;
  condition: PublicTreeCondition;
  tree_type_group: PublicTreeTypeGroup;
  tree_type_text: string | null;
  comment: string | null;
  created_at: string;
}

const PUBLIC_TREE_CLIENT_ID_KEY = "deadtrees-public-observations:client-id";

const trimOptional = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const parseGeometryPoint = (
  geom: PublicTreeObservationRow["geom"],
): PublicTreeGeometryPoint | null => {
  if (!geom) return null;

  if (typeof geom === "string") {
    try {
      const parsed = JSON.parse(geom) as PublicTreeGeometryPoint;
      return parsed.type === "Point" ? parsed : null;
    } catch {
      return null;
    }
  }

  return geom.type === "Point" ? geom : null;
};

export const rowToPublicTreeObservation = (
  row: PublicTreeObservationRow,
): PublicTreeObservation | null => {
  const geom = parseGeometryPoint(row.geom);
  if (!geom) return null;

  const [lon, lat] = geom.coordinates;
  return {
    id: row.id,
    lat,
    lon,
    condition: row.condition,
    treeTypeGroup: row.tree_type_group,
    treeTypeText: row.tree_type_text,
    comment: row.comment,
    clientId: null,
    createdAt: row.created_at,
  };
};

export const getPublicTreeClientId = () => {
  if (typeof window === "undefined") return null;

  const existing = window.localStorage.getItem(PUBLIC_TREE_CLIENT_ID_KEY);
  if (existing) return existing;

  const generated =
    typeof window.crypto?.randomUUID === "function"
      ? window.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  window.localStorage.setItem(PUBLIC_TREE_CLIENT_ID_KEY, generated);
  return generated;
};

export const publicTreeObservationsQueryKey = ["public-tree-observations"];

export const fetchPublicTreeObservations = async () => {
  const { data, error } = await supabase
    .from("public_tree_observations")
    .select(
      "id, geom, condition, tree_type_group, tree_type_text, comment, created_at",
    )
    .order("created_at", { ascending: false });

  if (error) throw error;

  return ((data ?? []) as PublicTreeObservationRow[])
    .map(rowToPublicTreeObservation)
    .filter(
      (observation): observation is PublicTreeObservation =>
        observation !== null,
    );
};

export const insertPublicTreeObservation = async (
  observation: PublicTreeObservationInput,
) => {
  const { error } = await supabase.from("public_tree_observations").insert({
    geom: {
      type: "Point",
      coordinates: [observation.lon, observation.lat],
    } satisfies PublicTreeGeometryPoint,
    condition: observation.condition,
    tree_type_group: observation.treeTypeGroup,
    tree_type_text:
      trimOptional(observation.treeTypeText)?.slice(0, 80) ?? null,
    comment: trimOptional(observation.comment)?.slice(0, 200) ?? null,
    client_id: trimOptional(observation.clientId)?.slice(0, 64) ?? null,
  });

  if (error) throw error;
};

export function usePublicTreeObservations() {
  const queryClient = useQueryClient();

  const observationsQuery = useQuery({
    queryKey: publicTreeObservationsQueryKey,
    queryFn: fetchPublicTreeObservations,
    staleTime: 10 * 1000,
  });

  const createObservation = useMutation({
    mutationFn: insertPublicTreeObservation,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: publicTreeObservationsQueryKey,
      });
    },
  });

  return {
    observations: observationsQuery.data ?? [],
    observationsQuery,
    createObservation,
  };
}
