import { Settings } from "../config";
import { supabase } from "../hooks/useSupabase";
import type { IDataAccess } from "../types/dataset";

/**
 * Access a named user holds on one dataset, as in 3Dtrees; the owner is never a grant.
 * Reader views (and downloads only when allowed), Editor also edits the dataset's
 * details, Admin also manages who has access.
 */
export type DatasetAccessRole = "reader" | "editor" | "admin";

export interface IMyDatasetAccess {
  is_owner: boolean;
  role: DatasetAccessRole | null;
  expires_at: string | null;
  can_view: boolean;
  /** Orthophoto bundles. */
  can_download: boolean;
  /** Prediction and label GeoPackages (also open to everyone on view-only datasets). */
  can_download_labels: boolean;
  can_edit_details: boolean;
  can_manage_access: boolean;
}

export interface IDatasetAccessEntry {
  user_id: string;
  email: string;
  is_owner: boolean;
  role: DatasetAccessRole | null;
  can_download: boolean;
  expires_at: string | null;
  is_expired: boolean;
  granted_at: string;
  granted_by_email: string | null;
}

export interface ISharedDataset {
  dataset_id: number;
  role: DatasetAccessRole;
  can_download: boolean;
  expires_at: string | null;
  granted_at: string;
  data_access: IDataAccess;
  file_name: string;
}

export interface IPrivateDatasetFiles {
  cog_url: string | null;
  thumbnail_url: string | null;
  expires_at: number;
}

/** What the signed-in user may do with a dataset; null when it is not visible to them. */
export async function fetchMyDatasetAccess(datasetId: number): Promise<IMyDatasetAccess | null> {
  const { data, error } = await supabase.rpc("my_dataset_access", { p_dataset_id: datasetId });
  if (error) throw error;
  return (data as IMyDatasetAccess[] | null)?.[0] ?? null;
}

export async function fetchDatasetAccessRoster(datasetId: number): Promise<IDatasetAccessEntry[]> {
  const { data, error } = await supabase.rpc("list_dataset_access", { p_dataset_id: datasetId });
  if (error) throw error;
  return (data as IDatasetAccessEntry[]) ?? [];
}

export async function setDatasetAccess(
  datasetId: number,
  email: string,
  role: DatasetAccessRole,
  canDownload: boolean,
  expiresAt: string | null,
): Promise<void> {
  const { error } = await supabase.rpc("set_dataset_access", {
    p_dataset_id: datasetId,
    p_email: email,
    p_role: role,
    p_can_download: canDownload,
    p_expires_at: expiresAt,
  });
  if (error) throw new Error(describeAccessError(error));
}

export async function revokeDatasetAccess(datasetId: number, userId: string): Promise<void> {
  const { error } = await supabase.rpc("revoke_dataset_access", { p_dataset_id: datasetId, p_user_id: userId });
  if (error) throw new Error(describeAccessError(error));
}

/** Registered account emails containing the query, for people who manage the dataset's access. */
export async function searchShareAccounts(datasetId: number, query: string): Promise<string[]> {
  const { data, error } = await supabase.rpc("search_dataset_share_accounts", { p_dataset_id: datasetId, p_query: query });
  if (error) throw new Error(describeAccessError(error));
  return ((data as { email: string }[] | null) ?? []).map((row) => row.email);
}

export async function fetchDatasetsSharedWithMe(): Promise<ISharedDataset[]> {
  const { data, error } = await supabase.rpc("list_datasets_shared_with_me");
  if (error) throw error;
  return (data as ISharedDataset[]) ?? [];
}

/** Turn database errors into sentences a person can act on. */
export function describeAccessError(error: { message?: string; hint?: string | null }): string {
  switch (error.hint) {
    case "registered_user_not_found":
      return "No DeadTrees account uses this email. Ask them to sign up first, then share again.";
    case "owner":
      return "This person owns the dataset and already has full access.";
    case "self":
      return "You cannot change your own access.";
    default:
      return error.message || "Access could not be changed. Please try again.";
  }
}

async function accessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Please sign in to continue.");
  return token;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    return typeof body?.detail === "string" ? body.detail : "Something went wrong. Please try again.";
  } catch {
    return "Something went wrong. Please try again.";
  }
}

export async function updateDatasetVisibility(datasetId: number, dataAccess: IDataAccess): Promise<void> {
  const response = await fetch(`${Settings.API_URL}/datasets/${datasetId}/visibility`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data_access: dataAccess }),
  });
  if (!response.ok) throw new Error(await readError(response));
}

// The API accepts at most this many datasets per request.
const FILE_TICKET_BATCH = 200;

/**
 * Signed, short-lived addresses for the COG and thumbnail of private datasets.
 * Datasets that are served publicly, or that the user cannot view, are absent;
 * a visitor who is not signed in can view no private dataset.
 */
export async function fetchPrivateDatasetFiles(datasetIds: number[]): Promise<Record<number, IPrivateDatasetFiles>> {
  if (datasetIds.length === 0) return {};
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) return {};
  const absolute = (path: string | null) => (path ? `${Settings.API_URL}${path}` : null);
  const files: Record<number, IPrivateDatasetFiles> = {};
  for (let start = 0; start < datasetIds.length; start += FILE_TICKET_BATCH) {
    const response = await fetch(`${Settings.API_URL}/datasets/files/tickets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ dataset_ids: datasetIds.slice(start, start + FILE_TICKET_BATCH) }),
    });
    if (!response.ok) throw new Error(await readError(response));
    const body = (await response.json()) as { files: Record<string, IPrivateDatasetFiles> };
    for (const [id, entry] of Object.entries(body.files)) {
      files[Number(id)] = { ...entry, cog_url: absolute(entry.cog_url), thumbnail_url: absolute(entry.thumbnail_url) };
    }
  }
  return files;
}

/**
 * The static COG path of a public or view-only dataset whose path the database
 * does not list to this caller. The API caps distinct datasets per account or
 * network per day; null when the dataset has no servable COG.
 */
export async function fetchPublicCogPath(datasetId: number): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  const response = await fetch(`${Settings.API_URL}/datasets/${datasetId}/files/cog`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await readError(response));
  return ((await response.json()) as { cog_path: string }).cog_path;
}

let pendingFileIds = new Set<number>();
let pendingFileRequest: Promise<Record<number, IPrivateDatasetFiles>> | null = null;

/**
 * Like fetchPrivateDatasetFiles, but datasets requested in the same tick (for
 * example the private rows of one list) share a single request.
 */
export function fetchPrivateDatasetFilesBatched(datasetIds: number[]): Promise<Record<number, IPrivateDatasetFiles>> {
  datasetIds.forEach((id) => pendingFileIds.add(id));
  if (!pendingFileRequest) {
    pendingFileRequest = Promise.resolve().then(() => {
      const ids = [...pendingFileIds].sort((a, b) => a - b);
      pendingFileIds = new Set();
      pendingFileRequest = null;
      return fetchPrivateDatasetFiles(ids);
    });
  }
  return pendingFileRequest;
}
