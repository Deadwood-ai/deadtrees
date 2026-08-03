import type { IPriwaPoint } from "./types";
import type {
  IPriwaGroupReviewItem,
  PriwaReviewStatus,
} from "./priwaReviewWorkspace";

export const priwaReviewStatusPresentation: Record<
  PriwaReviewStatus,
  { label: string; color: string }
> = {
  group_suggestion: { label: "Vorschlag prüfen", color: "gold" },
  flight_missing: { label: "Befliegung fehlt", color: "orange" },
  flight_suggested: { label: "Befliegung vorgeschlagen", color: "blue" },
  needs_review: { label: "Befliegung prüfen", color: "purple" },
  complete: { label: "Vollständig", color: "green" },
  unassigned_upload: { label: "Ohne Gruppe", color: "red" },
  excluded_upload: { label: "Ausgeschlossen", color: "default" },
};

export const formatPriwaReviewDate = (value: string | null) => {
  const match = value && /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : "ohne Datum";
};

export const getPriwaGroupDateRange = (
  item: IPriwaGroupReviewItem,
  points: IPriwaPoint[],
) => {
  const dates = item.treeIds
    .flatMap((treeId) => {
      const value = points.find((point) => point.id === treeId)?.datum;
      return value ? [value] : [];
    })
    .sort();
  if (dates.length === 0) return "ohne Baumdatum";
  const first = formatPriwaReviewDate(dates[0]);
  const last = formatPriwaReviewDate(dates.at(-1) ?? dates[0]);
  return first === last ? first : `${first}–${last}`;
};
