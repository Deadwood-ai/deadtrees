import { Settings } from "../config";
import { supabase } from "../hooks/useSupabase";
import type { ISignedFilesGrant } from "../utils/signedFilesGrant";
import { readError } from "./datasetAccess";

/** Ask the API for a signed link prefix; `accessPath` is the grant route, e.g. "/audit/images/access". */
export async function fetchSignedFilesGrant(accessPath: string): Promise<ISignedFilesGrant> {
  const { data } = await supabase.auth.getSession();
  const response = await fetch(`${Settings.API_URL}${accessPath}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${data?.session?.access_token ?? ""}` },
  });
  if (!response.ok) throw new Error(await readError(response));
  const body = (await response.json()) as { files_url: string; expires_at: number };
  return { filesUrl: `${Settings.API_URL}${body.files_url}`, expiresAt: body.expires_at };
}
