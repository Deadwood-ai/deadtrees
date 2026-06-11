import {
  publicTreeConditionLabels,
  publicTreeTypeGroupLabels,
  type PublicTreeObservation,
} from "../types/publicTreeObservations";

const csvHeaders = [
  "id",
  "created_at",
  "latitude",
  "longitude",
  "condition",
  "condition_label",
  "tree_type_group",
  "tree_type_label",
  "specific_species_name",
  "comment",
];

const escapeCsvCell = (value: string | number | null | undefined) => {
  const normalized = value === null || value === undefined ? "" : String(value);
  return `"${normalized.replace(/"/g, '""')}"`;
};

export const publicTreeObservationsToCsv = (
  observations: PublicTreeObservation[],
) => {
  const rows = observations.map((observation) => [
    observation.id,
    observation.createdAt,
    observation.lat,
    observation.lon,
    observation.condition,
    publicTreeConditionLabels[observation.condition],
    observation.treeTypeGroup,
    publicTreeTypeGroupLabels[observation.treeTypeGroup],
    observation.treeTypeText,
    observation.comment,
  ]);

  return [
    csvHeaders.map(escapeCsvCell).join(","),
    ...rows.map((row) => row.map(escapeCsvCell).join(",")),
  ].join("\n");
};

export const downloadPublicTreeObservationsCsv = (
  observations: PublicTreeObservation[],
) => {
  const csv = publicTreeObservationsToCsv(observations);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);

  anchor.href = url;
  anchor.download = `deadtrees-point-observations-${date}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};
