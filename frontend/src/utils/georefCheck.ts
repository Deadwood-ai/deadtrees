import type { IGeorefCheck, IGeorefReferenceEvidence } from "../types/georefCheck";

const REASONS: Record<string, string> = {
  no_fit: "no confident matches (uniform canopy, season or blank imagery)",
  few_inliers: "too few consistent matches",
  inconsistent_matches: "matches disagree with each other",
  clustered_matches: "matches cover only part of the image",
  no_support: "matches do not cover the area of interest",
  too_few_holdouts: "too few matches to cross-check",
  low_support: "matches cover less than 30% of the area of interest",
  unstable_near_threshold: "offset close to 15 m; the call flips under cross-checks",
  references_disagree: "references disagree about the 15 m line",
  no_qualified_reference: "no reference image matched reliably",
  on_null_line: "nothing matches and the image sits on the equator or prime meridian (lost coordinates)",
};

export const describeGeorefReason = (reason: string | null | undefined) => (reason ? (REASONS[reason] ?? reason.replace(/_/g, " ")) : "");

// Readable names for the registry (processor/src/georef_check_v1/providers.json);
// an unlisted provider shows its id.
const PROVIDER_NAMES: Record<string, string> = {
  maptiler: "MapTiler satellite",
  mapbox: "Mapbox satellite",
  "azure-maps": "Azure Maps imagery",
  "nz-linz-aerial": "LINZ aerial (NZ)",
  "us-naip-plus-usgs": "USGS NAIP Plus (US)",
  "us-noaa-west-2023": "NOAA coastal imagery (US)",
  "ch-swissimage": "swisstopo SWISSIMAGE",
  "at-basemap-ortho": "basemap.at Orthofoto",
  "fr-ign-bdortho": "IGN BD ORTHO (FR)",
  "es-pnoa-ma": "PNOA (ES)",
  "nl-pdok-ortho-hr": "PDOK luchtfoto (NL)",
  "au-qld-latest": "Queensland imagery",
  "au-nsw-six": "NSW imagery",
  "jp-gsi-seamlessphoto": "GSI seamless photo (JP)",
  "tw-nlsc-photo2": "NLSC ortho (TW)",
};

/** Human name of a reference provider, with its capture date where known. */
export function describeReference(check: IGeorefCheck, provider: string): string {
  const captured = check.metadata.references?.[provider]?.capture_date;
  if (provider === "esri") return "Esri World Imagery (current)";
  if (provider.startsWith("de-")) return `Orthophoto ${provider.slice(3).split("-")[0].toUpperCase()} (DE)`;
  if (provider.startsWith("wayback-")) return `Esri Wayback${captured ? `, captured ${captured}` : ""}`;
  return PROVIDER_NAMES[provider] ?? provider;
}

export interface GeorefSummary {
  tone: "success" | "error" | "warning";
  /** the call, e.g. "Poor, 19.8 m off" */
  verdict: string;
  /** what it rests on, or why it is uncertain */
  detail: string;
}

/** The check's call and what it rests on, for the audit card. */
export function summarizeGeorefCheck(check: IGeorefCheck): GeorefSummary {
  if (check.decision === "uncertain") {
    return { tone: "warning", verdict: "Uncertain", detail: `${capitalize(describeGeorefReason(check.reason))}. Please check by eye.` };
  }
  if (check.evidence_level === "gross") {
    return { tone: "error", verdict: "Poor", detail: `${capitalize(describeGeorefReason(check.reason))}.` };
  }
  const deciding = orderedReferences(check).filter((r) => r.decides);
  const names = deciding.slice(0, 2).map((r) => describeReference(check, r.provider));
  const more = deciding.length > 2 ? ` and ${deciding.length - 2} more` : "";
  const strength = check.evidence_level === "strong" ? "Strong" : "Moderate";
  return {
    tone: check.decision === "good" ? "success" : "error",
    verdict: `${check.decision === "good" ? "Good" : "Poor"}${check.p90_m === null ? "" : `, ${check.p90_m.toFixed(1)} m off`}`,
    detail: `${strength} evidence: 90% of the area is within this offset of ${names.join(", ")}${more}.`,
  };
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** References worth showing first: deciding ones, then by inliers. */
export function orderedReferences(check: IGeorefCheck): IGeorefReferenceEvidence[] {
  return [...check.reference_evidence].sort((a, b) => Number(b.decides) - Number(a.decides) || b.inliers - a.inliers);
}

/** Colour of a match by its offset: green well under 15 m, red over. */
export function offsetColor(metres: number): string {
  if (metres < 7.5) return "#2f9e44";
  if (metres < 15) return "#e8a10c";
  return "#d6336c";
}
