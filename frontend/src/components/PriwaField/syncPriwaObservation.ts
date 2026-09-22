import { supabase } from "../../hooks/useSupabase";
import type { IPriwaQueuedMutation } from "./priwaOfflineStore";
import { pointToRow } from "./usePriwaKaeferbaeume";

const conflict = () =>
  new Error(
    "Konflikt: Dieser Käferbaum wurde inzwischen geändert oder ist nicht mehr zugänglich. Ihre Offline-Änderung bleibt auf diesem Gerät gespeichert.",
  );

// All writes still use the signed-in user's RLS. The server revision is checked
// by the UPDATE itself, so a concurrent edit between read and write is safe.
export async function syncPriwaObservation(mutation: IPriwaQueuedMutation) {
  const { data: current, error: readError } = await supabase
    .from("priwa_kaeferbaeume")
    .select("id, updated_at, client_updated_at, updated_by")
    .eq("project_id", mutation.projectId)
    .eq("id", mutation.pointId)
    .maybeSingle();
  if (readError) throw readError;

  // An earlier request may have committed while its response was lost.
  if (
    current?.client_updated_at &&
    new Date(current.client_updated_at).getTime() ===
      new Date(mutation.updatedAt).getTime() &&
    current.updated_by === mutation.userId
  )
    return current.updated_at as string;

  // A repeated delete has already achieved its goal when RLS hides the row.
  if (!current && mutation.type === "delete") return mutation.updatedAt;

  const acknowledgedPrevious =
    current?.updated_by === mutation.userId &&
    !!current?.client_updated_at &&
    (mutation.attemptedUpdatedAts ?? []).some(
      (timestamp) =>
        new Date(timestamp).getTime() ===
        new Date(current.client_updated_at).getTime(),
    );

  if (mutation.type === "create" && !acknowledgedPrevious) {
    if (current || !mutation.point) throw conflict();
    const { data, error } = await supabase
      .from("priwa_kaeferbaeume")
      .insert({
        ...pointToRow(mutation.projectId, mutation.point),
        client_updated_at: mutation.updatedAt,
      })
      .select("updated_at")
      .single();
    if (error) throw error;
    return data.updated_at as string;
  }

  // Pre-upgrade queues never stored a server revision. Preserve their previous
  // overwrite behavior, while still guarding against a write racing this read.
  // New edits always carry their original revision and retain conflict checks.
  const baseUpdatedAt =
    (acknowledgedPrevious ? current?.updated_at : undefined) ??
    mutation.baseUpdatedAt ??
    mutation.point?.serverUpdatedAt ??
    current?.updated_at;
  if (!current || !baseUpdatedAt || current.updated_at !== baseUpdatedAt)
    throw conflict();
  const values =
    mutation.type === "delete"
      ? {
          deleted_at: mutation.updatedAt,
          deleted_by: mutation.userId,
          updated_by: mutation.userId,
          client_updated_at: mutation.updatedAt,
        }
      : mutation.point
        ? {
            ...pointToRow(mutation.projectId, mutation.point),
            client_updated_at: mutation.updatedAt,
          }
        : null;
  if (!values) throw conflict();
  const { data, error } = await supabase
    .from("priwa_kaeferbaeume")
    .update(values)
    .eq("project_id", mutation.projectId)
    .eq("id", mutation.pointId)
    .eq("updated_at", baseUpdatedAt)
    .select("updated_at")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw conflict();
  return data.updated_at as string;
}
