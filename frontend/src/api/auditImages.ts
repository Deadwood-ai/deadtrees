import { Settings } from "../config";
import { supabase } from "../hooks/useSupabase";
import { readError } from "./datasetAccess";

export interface IAuditImagesGrant {
  /** Absolute prefix of the signed audit image links. */
  filesUrl: string;
  /** Unix seconds when the links stop working. */
  expiresAt: number;
}

/** Signed links to the images the audit checks judged; auditors only. */
export async function fetchAuditImages(): Promise<IAuditImagesGrant> {
  const { data } = await supabase.auth.getSession();
  const response = await fetch(`${Settings.API_URL}/audit/images/access`, {
    method: "POST",
    headers: { Authorization: `Bearer ${data?.session?.access_token ?? ""}` },
  });
  if (!response.ok) throw new Error(await readError(response));
  const body = (await response.json()) as { files_url: string; expires_at: number };
  return { filesUrl: `${Settings.API_URL}${body.files_url}`, expiresAt: body.expires_at };
}

/** The link of one stored image; storage_path is relative to the data directory and starts with audit/. */
export function auditImageUrl(grant: IAuditImagesGrant, storagePath: string): string {
  return `${grant.filesUrl}/${storagePath.replace(/^audit\//, "")}`;
}
