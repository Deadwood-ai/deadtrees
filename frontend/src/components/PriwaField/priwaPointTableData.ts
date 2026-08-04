import {
  getPriwaFundLabel,
  getPriwaPointSourceLabel,
  getPriwaPointTitle,
} from "./priwaPointQa";
import type { IPriwaBefallsgruppe, IPriwaPoint } from "./types";

export type PriwaPointSearchField =
  | "all"
  | "baumnr"
  | "datum"
  | "group"
  | "flight"
  | "baumart"
  | "fund"
  | "name"
  | "comment"
  | "source";

export const comparePriwaTableText = (
  left: string | null | undefined,
  right: string | null | undefined,
) =>
  (left ?? "").localeCompare(right ?? "", "de", {
    numeric: true,
    sensitivity: "base",
  });

export const filterPriwaPointsBySearch = (
  points: IPriwaPoint[],
  search: string,
  field: PriwaPointSearchField,
  groupByTreeId: Record<string, IPriwaBefallsgruppe>,
  confirmedFlightLabelsByTreeId: Record<string, string[]>,
) => {
  const searchTerms = search
    .trim()
    .toLocaleLowerCase("de")
    .split(/\s+/)
    .filter(Boolean);

  if (searchTerms.length === 0) return points;

  return points.filter((point) => {
    const valuesByField: Record<PriwaPointSearchField, unknown[]> = {
      all: [
        getPriwaPointTitle(point),
        getPriwaPointSourceLabel(point),
        getPriwaFundLabel(point),
        point.datum,
        point.baumart,
        point.bm,
        point.bohrloch,
        point.harz,
        point.grueneNadelnAmBoden,
        point.nadel,
        point.rinde,
        point.kv,
        point.name,
        point.kom,
        point.lat,
        point.lon,
        groupByTreeId[point.id]?.name,
        ...(confirmedFlightLabelsByTreeId[point.id] ?? []),
      ],
      baumnr: [getPriwaPointTitle(point)],
      datum: [point.datum],
      group: [groupByTreeId[point.id]?.name],
      flight: confirmedFlightLabelsByTreeId[point.id] ?? [],
      baumart: [point.baumart],
      fund: [getPriwaFundLabel(point)],
      name: [point.name],
      comment: [point.kom],
      source: [getPriwaPointSourceLabel(point)],
    };
    const searchText = valuesByField[field]
      .filter((value) => value !== null && value !== undefined)
      .join(" ")
      .toLocaleLowerCase("de");

    return searchTerms.every((term) => searchText.includes(term));
  });
};
