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

/** Human name of a reference provider, with its capture date where known. */
export function describeReference(check: IGeorefCheck, provider: string): string {
  const captured = check.metadata.references?.[provider]?.capture_date;
  if (provider === "esri") return "Esri World Imagery (current)";
  if (provider.startsWith("wayback-")) return `Esri Wayback${captured ? `, captured ${captured}` : ""}`;
  return { google: "Google satellite", maptiler: "MapTiler satellite", mapbox: "Mapbox satellite" }[provider] ?? provider;
}

/** One-line summary for the audit card. */
export function summarizeGeorefCheck(check: IGeorefCheck): { tone: "success" | "error" | "warning"; text: string } {
  if (check.decision === "uncertain") {
    return { tone: "warning", text: `Uncertain: ${describeGeorefReason(check.reason)}. Please check by eye.` };
  }
  if (check.evidence_level === "gross") {
    return { tone: "error", text: `Poor: ${describeGeorefReason(check.reason)}.` };
  }
  const deciding = check.reference_evidence.filter((r) => r.decides);
  const offset = check.p90_m === null ? "" : `${check.p90_m.toFixed(1)} m`;
  const refs = `${deciding.length} reference${deciding.length === 1 ? "" : "s"}`;
  const strength = check.evidence_level === "strong" ? "strong evidence" : "moderate evidence";
  return {
    tone: check.decision === "good" ? "success" : "error",
    text: `${check.decision === "good" ? "Good" : "Poor"}: offset ${offset} (90% of the area) on ${refs}, ${strength}.`,
  };
}

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
