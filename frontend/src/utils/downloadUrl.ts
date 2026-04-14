import { Settings } from "../config";

const ABSOLUTE_URL_PATTERN = /^https?:\/\//i;

export const resolveDownloadUrl = (downloadPath?: string, fallbackUrl?: string): string | null => {
  const candidate = downloadPath?.trim() || fallbackUrl?.trim();
  if (!candidate) return null;

  if (ABSOLUTE_URL_PATTERN.test(candidate)) {
    return candidate;
  }

  const apiOrigin = new URL(Settings.API_URL).origin;
  return new URL(candidate, `${apiOrigin}/`).toString();
};
