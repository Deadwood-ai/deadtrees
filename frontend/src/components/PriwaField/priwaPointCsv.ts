import type { IPriwaPoint } from "./types";

const csvHeaders = [
  "id",
  "baumnr",
  "fund",
  "baumart",
  "bohrmehl",
  "bohrloch",
  "harz",
  "gruene_nadeln_am_boden",
  "nadelverfaerbung",
  "rindenverlust",
  "nadelverlust",
  "name",
  "datum",
  "latitude",
  "longitude",
  "coordinate_source",
  "is_estimated_location",
  "captured_at",
  "kommentar",
  "sync_status",
];

const escapeCsvCell = (value: string | number | boolean | null | undefined) => {
  const normalized = value === null || value === undefined ? "" : String(value);
  return `"${normalized.replace(/"/g, '""')}"`;
};

export const priwaPointsToCsv = (points: IPriwaPoint[]) => {
  const rows = points.map((point) => [
    point.id,
    point.baumnr,
    point.fund,
    point.baumart,
    point.bm,
    point.bohrloch,
    point.harz,
    point.grueneNadelnAmBoden,
    point.nadel,
    point.rinde,
    point.kv,
    point.name,
    point.datum,
    point.lat,
    point.lon,
    point.coordinateSource,
    point.isEstimatedLocation ?? false,
    point.capturedAt,
    point.kom,
    point.syncStatus ?? "synced",
  ]);

  return [
    csvHeaders.map(escapeCsvCell).join(","),
    ...rows.map((row) => row.map(escapeCsvCell).join(",")),
  ].join("\n");
};

export const downloadPriwaPointsCsv = (
  points: IPriwaPoint[],
  projectName: string,
) => {
  const csv = priwaPointsToCsv(points);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  const safeProjectName = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  anchor.href = url;
  anchor.download = `priwa-kaeferbaeume-${safeProjectName || "projekt"}-${date}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};
