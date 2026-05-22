import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "../../hooks/useSupabase";
import { useAuth } from "../../hooks/useAuthProvider";
import type { IPriwaPoint, PriwaCoordinateSource } from "./types";

type PriwaDbLocationSource = "qr_exact" | "gps_estimated" | "map_estimated";

interface IPriwaGeometryPoint {
  type: "Point";
  coordinates: [number, number];
}

interface IPriwaKaeferbaumRow {
  id: string;
  project_id: string;
  geom: IPriwaGeometryPoint | string | null;
  location_source: PriwaDbLocationSource;
  is_exact_location?: boolean;
  baumnr: string | null;
  fund: IPriwaPoint["fund"];
  baumart: IPriwaPoint["baumart"];
  bm: IPriwaPoint["bm"];
  bohrloch: IPriwaPoint["bohrloch"];
  harz: IPriwaPoint["harz"];
  gruene_nadeln_am_boden: IPriwaPoint["grueneNadelnAmBoden"] | null;
  nadel: IPriwaPoint["nadel"];
  rinde: IPriwaPoint["rinde"] | null;
  kv: IPriwaPoint["kv"] | null;
  name: IPriwaPoint["name"];
  datum: string;
  kom: string | null;
  raw_qr_value: string | null;
  created_at: string;
  updated_at: string;
  client_updated_at: string | null;
}

const toDbLocationSource = (
  source: PriwaCoordinateSource,
): PriwaDbLocationSource => {
  if (source === "qr") return "qr_exact";
  if (source === "gps") return "gps_estimated";
  return "map_estimated";
};

const fromDbLocationSource = (
  source: PriwaDbLocationSource,
): PriwaCoordinateSource => {
  if (source === "qr_exact") return "qr";
  if (source === "gps_estimated") return "gps";
  return "map";
};

const parseGeometryPoint = (
  geom: IPriwaKaeferbaumRow["geom"],
): IPriwaGeometryPoint | null => {
  if (!geom) return null;

  if (typeof geom === "string") {
    try {
      const parsed = JSON.parse(geom) as IPriwaGeometryPoint;
      return parsed.type === "Point" ? parsed : null;
    } catch {
      return null;
    }
  }

  return geom.type === "Point" ? geom : null;
};

const rowToPoint = (row: IPriwaKaeferbaumRow): IPriwaPoint | null => {
  const geom = parseGeometryPoint(row.geom);
  if (!geom) return null;

  const [lon, lat] = geom.coordinates;
  const coordinateSource = fromDbLocationSource(row.location_source);

  return {
    id: row.id,
    lat,
    lon,
    baumnr: row.baumnr ?? "",
    fund: row.fund,
    baumart: row.baumart,
    bm: row.bm,
    bohrloch: row.bohrloch,
    harz: row.harz,
    grueneNadelnAmBoden: row.gruene_nadeln_am_boden ?? "nein",
    nadel: row.nadel,
    rinde: row.rinde ?? "0%",
    kv: row.kv ?? "0%",
    name: row.name,
    datum: row.datum,
    kom: row.kom ?? "",
    capturedAt: row.created_at,
    coordinateSource,
    gps: coordinateSource === "qr" ? "ja" : "nein",
    isEstimatedLocation: row.location_source !== "qr_exact",
    rawQrValue: row.raw_qr_value ?? undefined,
  };
};

const pointToRow = (projectId: string, point: IPriwaPoint) => ({
  id: point.id,
  project_id: projectId,
  geom: {
    type: "Point",
    coordinates: [point.lon, point.lat],
  } satisfies IPriwaGeometryPoint,
  location_source: toDbLocationSource(point.coordinateSource),
  baumnr: point.baumnr.trim() || null,
  fund: point.fund,
  baumart: point.baumart,
  bm: point.bm,
  bohrloch: point.bohrloch,
  harz: point.harz,
  gruene_nadeln_am_boden: point.grueneNadelnAmBoden ?? "nein",
  nadel: point.nadel,
  rinde: point.rinde || null,
  kv: point.kv || null,
  name: point.name,
  datum: point.datum,
  kom: point.kom.trim() || null,
  raw_qr_value: point.rawQrValue?.trim() || null,
  client_updated_at: new Date().toISOString(),
});

export const priwaPointsQueryKey = (projectId: string | null | undefined) => [
  "priwa-kaeferbaeume",
  projectId,
];

export const fetchPriwaKaeferbaeume = async (projectId: string) => {
  const { data, error } = await supabase
    .from("priwa_kaeferbaeume")
    .select(
      "id, project_id, geom, location_source, is_exact_location, baumnr, fund, baumart, bm, bohrloch, harz, gruene_nadeln_am_boden, nadel, rinde, kv, name, datum, kom, raw_qr_value, created_at, updated_at, client_updated_at",
    )
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });

  if (error) throw error;

  return ((data ?? []) as IPriwaKaeferbaumRow[])
    .map(rowToPoint)
    .filter((point): point is IPriwaPoint => point !== null);
};

export const upsertPriwaKaeferbaum = async (
  projectId: string,
  point: IPriwaPoint,
) => {
  const { error } = await supabase
    .from("priwa_kaeferbaeume")
    .upsert(pointToRow(projectId, point), { onConflict: "id" });

  if (error) throw error;
};

export const softDeletePriwaKaeferbaum = async (
  pointId: string,
  userId: string,
  deletedAt = new Date().toISOString(),
) => {
  const { error } = await supabase
    .from("priwa_kaeferbaeume")
    .update({
      deleted_at: deletedAt,
      deleted_by: userId,
      updated_by: userId,
      client_updated_at: deletedAt,
    })
    .eq("id", pointId);

  if (error) throw error;
};

export function usePriwaKaeferbaeume(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const pointsQuery = useQuery({
    queryKey: priwaPointsQueryKey(projectId),
    enabled: !!projectId,
    queryFn: async () => {
      if (!projectId) return [];
      return fetchPriwaKaeferbaeume(projectId);
    },
    staleTime: 30 * 1000,
  });

  const invalidatePoints = async () => {
    await queryClient.invalidateQueries({
      queryKey: priwaPointsQueryKey(projectId),
    });
  };

  const createPoint = useMutation({
    mutationFn: async (point: IPriwaPoint) => {
      if (!projectId) throw new Error("PRIWA project membership is required.");
      await upsertPriwaKaeferbaum(projectId, point);
    },
    onSuccess: invalidatePoints,
  });

  const updatePoint = useMutation({
    mutationFn: async (point: IPriwaPoint) => {
      if (!projectId) throw new Error("PRIWA project membership is required.");
      await upsertPriwaKaeferbaum(projectId, point);
    },
    onSuccess: invalidatePoints,
  });

  const deletePoint = useMutation({
    mutationFn: async (pointId: string) => {
      if (!userId) throw new Error("PRIWA user session is required.");
      await softDeletePriwaKaeferbaum(pointId, userId);
    },
    onSuccess: invalidatePoints,
  });

  return {
    points: pointsQuery.data ?? [],
    isLoading: pointsQuery.isLoading,
    isRefetching: pointsQuery.isRefetching,
    error: pointsQuery.error,
    createPoint: createPoint.mutateAsync,
    updatePoint: updatePoint.mutateAsync,
    deletePoint: deletePoint.mutateAsync,
    isSaving:
      createPoint.isPending || updatePoint.isPending || deletePoint.isPending,
  };
}
