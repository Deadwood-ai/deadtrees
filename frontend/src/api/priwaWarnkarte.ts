import type { FeatureCollection, Polygon } from "geojson";

import { Settings } from "../config";

export interface IPriwaWarnkarteValidationWarning {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export interface IPriwaWarnkarteValidationSummary {
  source_filename: string;
  checksum_sha256: string;
  authoritative_date: string;
  layer: string;
  crs: string;
  feature_count: number;
  warnings: IPriwaWarnkarteValidationWarning[];
}

export type IPriwaWarnkarteOverlay = FeatureCollection<
  Polygon,
  { probability: number }
> & {
  version_id: string | null;
  source_date: string | null;
};

export interface IPriwaWarnkarteVersion {
  id: string;
  source_date: string;
  source_filename: string;
  checksum_sha256: string;
  source_layer: string;
  source_crs: string;
  feature_count: number;
  imported_by: string;
  imported_at: string;
  is_current: boolean;
}

export interface IPriwaWarnkarteImportResponse {
  version_id: string;
  summary: IPriwaWarnkarteValidationSummary;
}

export class PriwaWarnkarteApiError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PriwaWarnkarteApiError";
    this.code = code;
    this.details = details;
  }
}

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
});

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>;

  const body = await response.json().catch(() => null);
  const detail = body?.detail;
  if (detail && typeof detail === "object") {
    throw new PriwaWarnkarteApiError(
      detail.code || "REQUEST_FAILED",
      detail.message || "Die Warnkarten-Anfrage ist fehlgeschlagen.",
      detail.details || {},
    );
  }

  throw new PriwaWarnkarteApiError(
    "REQUEST_FAILED",
    typeof detail === "string"
      ? detail
      : `Die Warnkarten-Anfrage ist fehlgeschlagen (${response.status}).`,
  );
}

const uploadForm = (projectId: string, file: File) => {
  const form = new FormData();
  form.append("project_id", projectId);
  form.append("file", file);
  return form;
};

export async function validatePriwaWarnkarte(
  projectId: string,
  file: File,
  token: string,
) {
  const response = await fetch(`${Settings.API_URL}/priwa/warnkarte/validate`, {
    method: "POST",
    headers: authHeaders(token),
    body: uploadForm(projectId, file),
  });
  return parseResponse<IPriwaWarnkarteValidationSummary>(response);
}

export async function importPriwaWarnkarte(
  projectId: string,
  file: File,
  confirmedDate: string,
  token: string,
) {
  const form = uploadForm(projectId, file);
  form.append("confirmed_date", confirmedDate);
  const response = await fetch(`${Settings.API_URL}/priwa/warnkarte/import`, {
    method: "POST",
    headers: authHeaders(token),
    body: form,
  });
  return parseResponse<IPriwaWarnkarteImportResponse>(response);
}

export async function fetchPriwaWarnkarteVersions(
  projectId: string,
  token: string,
) {
  const query = new URLSearchParams({ project_id: projectId });
  const response = await fetch(
    `${Settings.API_URL}/priwa/warnkarte/versions?${query}`,
    { headers: authHeaders(token) },
  );
  return parseResponse<IPriwaWarnkarteVersion[]>(response);
}

export async function fetchActivePriwaWarnkarte(
  projectId: string,
  token: string,
) {
  const query = new URLSearchParams({ project_id: projectId });
  const response = await fetch(
    `${Settings.API_URL}/priwa/warnkarte/active?${query}`,
    { headers: authHeaders(token) },
  );
  return parseResponse<IPriwaWarnkarteOverlay>(response);
}

export async function fetchPriwaWarnkarteVersionOverlay(
  projectId: string,
  versionId: string,
  token: string,
) {
  const query = new URLSearchParams({ project_id: projectId });
  const response = await fetch(
    `${Settings.API_URL}/priwa/warnkarte/versions/${versionId}/overlay?${query}`,
    { headers: authHeaders(token) },
  );
  return parseResponse<IPriwaWarnkarteOverlay>(response);
}

export async function publishPriwaWarnkarteVersion(
  versionId: string,
  token: string,
) {
  const response = await fetch(
    `${Settings.API_URL}/priwa/warnkarte/versions/${versionId}/publish`,
    { method: "POST", headers: authHeaders(token) },
  );
  return parseResponse<{ publication_id: number; version_id: string }>(
    response,
  );
}
