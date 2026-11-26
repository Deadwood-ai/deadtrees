/** The dataset page's audit rows in words, for data users: the decision, the georeferencing and
 * how many of the sample crops each prediction gets wrong. */

import type { IDatasetAuditSummary, ReviewItem } from "../types/auditChecks";
import { GEOREF_PASS_M } from "./auditReview";

const metres = (m: number) => `${m < 10 ? m.toFixed(1) : Math.round(m)} m`;

/** A finding waits while a person still has to review its check, and only then: an open
 * evaluation review does not hide the georeferencing. */
export const reviewOpen = (summary: IDatasetAuditSummary, item: ReviewItem) => summary.review_required.includes(item);

/** The georeferencing in words; null while there is none to show (not run, or waiting for a
 * person), which the page shows as pending. */
export function georefFinding(summary: IDatasetAuditSummary | null | undefined): string | null {
  if (!summary || reviewOpen(summary, "georef")) return null;
  const offset = summary.georef_offset_m;
  switch (summary.georef_status) {
    case "estimated":
      return offset == null ? "Compared with reference imagery" : `About ${metres(offset)} off`;
    case "passed":
      return `Within ${GEOREF_PASS_M} m`;
    case "not_passed":
      return `More than ${GEOREF_PASS_M} m off`;
    case "no_reference":
      return "No reference imagery";
    default:
      return null;
  }
}

/** A prediction's sample crops with major and minor errors, or null when none were checked. */
export function predictionFinding(total: number | null, major: number | null, minor: number | null): string | null {
  if (!total) return null;
  return `${major ?? 0}/${total} major, ${minor ?? 0} minor`;
}

/** A model's sentence for data users: without the error type codes it cites ("(m2)", or
 * "(m1, low confidence)" as "(low confidence)") and without pixel positions in the crop, which
 * the page does not show ("(about x 520-625, y 60-210)", "near x 812-852, y 465-482"). */
export const readableReason = (sentence: string) =>
  sentence
    // positions: "x 520-625, y 60-210", "(350,205)", "(about 260-320, 730-800)"
    .replace(/\s*(?:at|near|around)?\s*(?:about\s+)?x\s*\d+(?:\s*-\s*\d+)?\s*,?\s*y\s*\d+(?:\s*-\s*\d+)?/gi, "")
    .replace(/\s*(?:at|near|around)?\s*(?:about\s+)?\(\s*(?:about\s+)?\d+(?:\s*-\s*\d+)?\s*,\s*\d+(?:\s*-\s*\d+)?\s*\)/gi, "")
    .replace(/\(([^)]*)\)/g, (_, inner: string) => {
      const rest = inner
        .split(/[,;]/)
        .map((part) => part.trim())
        .filter((part) => part && !/^(about|and|possible|e\.g\.)?$/i.test(part) && !/^(possible\s+)?m\d+(\s+(absent|not present))?$/i.test(part));
      return rest.length ? `(${rest.join(", ")})` : "";
    })
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();

/** What the model said on a crop, for data users: its summary, else its error sentences. */
export const cropReasoning = (crop: { summary?: string | null; errors: string[] }) =>
  crop.summary?.trim() || crop.errors.map(readableReason).join(" ");
