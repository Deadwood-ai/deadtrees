/** What the review set on a dataset, condensed for the top of the audit page: per step the review
 * that counts, who gave it and when. An audit has one review; a later answer replaces an earlier one. */

import type { IAuditDatasetResult, IAuditReviews, IDatasetReview, ITileReview } from "../types/auditChecks";
import { evaluationAnswerText } from "./auditChecks";
import { GEOREF_LABELS } from "./auditReview";

export interface IReviewChange {
  step: string;
  value: string;
  by: string;
  at: string;
}

const AOI_BY_HAND = new Set(["manual", "manual_correction"]);
const who = (row: IDatasetReview | ITileReview) => row.reviewer_email ?? row.reviewed_by ?? "a reviewer";

export function reviewChanges(reviews: IAuditReviews | undefined, result: IAuditDatasetResult | null | undefined): IReviewChange[] {
  const changes: IReviewChange[] = [];
  const add = (step: string, row: IDatasetReview | ITileReview | undefined, value: string | null) => {
    if (row && value) changes.push({ step, value, by: who(row), at: row.created_at });
  };
  // a review given on an earlier ortho (or date advice) no longer counts
  const datasetReview = (checkKey: IDatasetReview["check_key"]) => reviews?.datasetReviews.find((r) => r.check_key === checkKey && !r.stale);

  const evaluation = datasetReview("dataset_evaluation");
  add("Decision", evaluation, evaluation ? evaluationAnswerText(evaluation) : null);
  if (result?.aoi_source && AOI_BY_HAND.has(result.aoi_source) && result.aoi_created_at) {
    changes.push({ step: "Area of interest", value: result.aoi_source === "manual" ? "drawn" : "corrected", by: "by hand", at: result.aoi_created_at });
  }
  const georef = datasetReview("georef");
  add("Georeferencing", georef, georef?.georef_status ? GEOREF_LABELS[georef.georef_status].split(" (")[0] : null);
  const date = datasetReview("acquisition_date");
  add("Acquisition date", date, typeof date?.date_replace === "boolean" ? (date.date_replace ? "Replace the reported date" : "Keep the reported date") : null);
  for (const [layer, step] of [["forest_cover", "Tree cover"], ["deadwood", "Deadwood"]] as const) {
    const rows = (reviews?.tileReviews ?? []).filter((r) => r.layer === layer);
    const latest = rows.reduce<ITileReview | undefined>((l, r) => (!l || r.id > l.id ? r : l), undefined);
    add(step, latest, rows.length ? `${rows.length} crop decision${rows.length > 1 ? "s" : ""}` : null);
  }
  return changes;
}
