/** What the review set on a dataset, condensed for the top of the audit page: per step the latest
 * reviewer answer, who gave it and when. An audit has one review; a later answer replaces an
 * earlier one. */

import type { IAuditAssessment, IAuditDatasetResult } from "../types/auditChecks";
import { evaluationAnswerText } from "./auditChecks";
import { GEOREF_LABELS } from "./auditReview";

export interface IReviewChange {
  step: string;
  value: string;
  by: string;
  at: string;
}

const AOI_BY_HAND = new Set(["manual", "manual_correction"]);
const latest = (rows: IAuditAssessment[]) => rows.reduce<IAuditAssessment | null>((l, r) => (!l || r.id > l.id ? r : l), null);
const who = (row: IAuditAssessment) => row.assessor_email ?? row.assessor_user_id ?? "a reviewer";

export function reviewChanges(people: IAuditAssessment[], result: IAuditDatasetResult | null | undefined): IReviewChange[] {
  const changes: IReviewChange[] = [];
  const add = (step: string, row: IAuditAssessment | null, value: (row: IAuditAssessment) => string | null) => {
    const said = row && value(row);
    if (row && said && row.created_at) changes.push({ step, value: said, by: who(row), at: row.created_at });
  };
  const datasetRow = (checkKey: string) => latest(people.filter((p) => p.check_key === checkKey && p.crop_id === null));

  add("Decision", datasetRow("dataset_evaluation"), evaluationAnswerText);
  if (result?.aoi_source && AOI_BY_HAND.has(result.aoi_source) && result.aoi_created_at) {
    changes.push({ step: "Area of interest", value: result.aoi_source === "manual" ? "drawn" : "corrected", by: "by hand", at: result.aoi_created_at });
  }
  add("Georeferencing", datasetRow("georef"), (r) => {
    const status = r.output?.status;
    return status === "passed" || status === "not_passed" ? GEOREF_LABELS[status].split(" (")[0] : null;
  });
  add("Acquisition date", datasetRow("acquisition_date"), (r) =>
    typeof r.output?.replace === "boolean" ? (r.output.replace ? "Replace the reported date" : "Keep the reported date") : null,
  );
  for (const [layer, step] of [["forest_cover", "Tree cover"], ["deadwood", "Deadwood"]] as const) {
    const rows = people.filter((p) => p.check_key === "prediction_quality" && p.crop_id !== null && p.layer === layer);
    const crops = new Set(rows.map((r) => r.crop_id)).size;
    add(step, latest(rows), () => (crops ? `${crops} crop decision${crops > 1 ? "s" : ""}` : null));
  }
  return changes;
}
