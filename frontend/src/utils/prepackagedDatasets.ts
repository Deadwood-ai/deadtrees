import type {
  IPrepackagedDatasetPackage,
  IPrepackagedDatasetVersion,
} from "../api/prepackaged";

export const prepackagedNumberFormatter = new Intl.NumberFormat("en-US");

export function formatPrepackagedBytes(bytes: number) {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${prepackagedNumberFormatter.format(bytes)} B`;
}

export function formatPrepackagedDate(value: string | null) {
  if (!value) return "Unknown";

  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

export function prepackagedKindLabel(kind: IPrepackagedDatasetPackage["kind"]) {
  switch (kind) {
    case "tiles":
      return "Image tiles";
    case "labels":
      return "Labels";
    case "satellite":
      return "Satellite";
    case "vector":
    default:
      return "Vector";
  }
}

export function getLatestPrepackagedVersion(
  datasetPackage: IPrepackagedDatasetPackage,
): IPrepackagedDatasetVersion | null {
  return datasetPackage.versions[0] ?? null;
}
