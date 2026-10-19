import { Settings } from "../config";
import { supabase } from "../hooks/useSupabase";
import { readError } from "./datasetAccess";

export interface IBenchmarkFilesGrant {
  /** Absolute prefix of the signed benchmark file links. */
  filesUrl: string;
  /** Unix seconds when the links stop working. */
  expiresAt: number;
}

/** Signed links to the internal disturbance benchmark files; core team only. */
export async function fetchBenchmarkFiles(): Promise<IBenchmarkFilesGrant> {
  const { data } = await supabase.auth.getSession();
  const response = await fetch(
    `${Settings.API_URL}/disturbance-benchmark/access`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${data?.session?.access_token ?? ""}` },
    },
  );
  if (!response.ok) throw new Error(await readError(response));
  const body = (await response.json()) as {
    files_url: string;
    expires_at: number;
  };
  return {
    filesUrl: `${Settings.API_URL}${body.files_url}`,
    expiresAt: body.expires_at,
  };
}
