import { Settings } from "../config";

export interface IPrepackagedDatasetVersion {
  id: number;
  version: string;
  status: string;
  file_name: string;
  public_download_path: string;
  size_bytes: number;
  checksum_sha256: string | null;
  dataset_count: number | null;
  artifact_count: number | null;
  built_at: string | null;
  published_at: string | null;
  source_commit: string | null;
  source_package_version: string | null;
  manifest: Record<string, unknown>;
  known_issues: string | null;
}

export interface IPrepackagedDatasetPackage {
  id: number;
  slug: string;
  title: string;
  summary: string;
  description: string | null;
  technical_description: string | null;
  source_repository_url: string | null;
  source_file_path: string | null;
  kind: "vector" | "tiles" | "labels" | "satellite";
  sort_order: number;
  versions: IPrepackagedDatasetVersion[];
}

export interface IPrepackagedDownloadGrant {
  grant_id: string;
  version_id: number;
  expires_at: string;
  download_url: string;
}

const buildAuthHeaders = (token?: string) =>
  token ? { Authorization: `Bearer ${token}` } : undefined;

export async function fetchPrepackagedPackages(): Promise<
  IPrepackagedDatasetPackage[]
> {
  const response = await fetch(`${Settings.API_URL}/prepackaged/packages`);

  if (!response.ok) {
    throw new Error(`Failed to load prepackaged datasets (${response.status})`);
  }

  return response.json();
}

export async function createPrepackagedDownloadGrant(
  versionId: number,
  token: string,
): Promise<IPrepackagedDownloadGrant> {
  const response = await fetch(
    `${Settings.API_URL}/prepackaged/versions/${versionId}/download-grant`,
    {
      method: "POST",
      headers: buildAuthHeaders(token),
    },
  );

  if (!response.ok) {
    const detail = await response
      .json()
      .then((body) => body?.detail)
      .catch(() => null);
    throw new Error(
      detail || `Failed to create download grant (${response.status})`,
    );
  }

  return response.json();
}
