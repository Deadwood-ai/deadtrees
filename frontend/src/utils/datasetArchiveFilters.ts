import { IDataAccess, type IDatasetArchiveItem } from "../types/dataset";

/**
 * Every filter of the drone archive list and map, in one value. `null` or an
 * empty list means the filter is off, so a dataset with a missing value (no
 * acquisition month, no resolution) only drops out once its filter is used.
 */
export interface ArchiveFilters {
  authors: string[];
  countries: string[];
  places: string[];
  biomes: string[];
  platforms: string[];
  access: IDataAccess[];
  years: [number, number] | null;
  months: [number, number] | null;
  gsdCm: [number, number] | null;
  // Upload (contribution) dates as YYYY-MM-DD, both ends inclusive.
  uploaded: [string, string] | null;
}

export const EMPTY_ARCHIVE_FILTERS: ArchiveFilters = {
  authors: [],
  countries: [],
  places: [],
  biomes: [],
  platforms: [],
  access: [],
  years: null,
  months: null,
  gsdCm: null,
  uploaded: null,
};

/** The values a list chip (place, country, author, biome) can add as a filter. */
export type ArchiveChipFilter = "places" | "countries" | "authors" | "biomes";

export type ArchiveFilterable = Pick<
  IDatasetArchiveItem,
  | "authors"
  | "admin_level_1"
  | "admin_level_2"
  | "admin_level_3"
  | "biome_name"
  | "platform"
  | "data_access"
  | "aquisition_year"
  | "aquisition_month"
  | "created_at"
  | "gsd_cm"
>;

export const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// The year slider starts here; at this stop it also keeps older datasets.
export const ACQUISITION_YEAR_FLOOR = 2010;

// Resolution slider stops in cm/px. The last stop has no upper bound.
export const GSD_STOPS_CM = [0, 1, 2, 3, 5, 10, 20, 50];

const ACCESS_LABELS: Record<IDataAccess, string> = {
  [IDataAccess.public]: "Public",
  [IDataAccess.viewonly]: "View only",
  [IDataAccess.private]: "Private",
};

export const accessLabel = (access: IDataAccess) => ACCESS_LABELS[access];

const placeOf = (item: ArchiveFilterable) => item.admin_level_3 || item.admin_level_2 || "";

const inRange = (value: number, [from, to]: [number, number]) =>
  value >= from && value <= to;

const withinGsd = (gsd: number, [from, to]: [number, number]) =>
  gsd >= from && (to >= GSD_STOPS_CM[GSD_STOPS_CM.length - 1] || gsd <= to);

const uploadDay = (createdAt: string) => createdAt.slice(0, 10);

/** One predicate for the whole filter set, built once per filter change. */
export function createArchiveFilter(filters: ArchiveFilters) {
  const authors = new Set(filters.authors);
  const countries = new Set(filters.countries);
  const places = new Set(filters.places);
  const biomes = new Set(filters.biomes);
  const platforms = new Set(filters.platforms);
  const access = new Set<string>(filters.access);
  const { years, months, gsdCm, uploaded } = filters;

  return (item: ArchiveFilterable): boolean => {
    if (authors.size && !item.authors?.some((author) => authors.has(author))) return false;
    if (countries.size && !countries.has(item.admin_level_1 ?? "")) return false;
    if (places.size && !places.has(placeOf(item))) return false;
    if (biomes.size && !biomes.has(item.biome_name ?? "")) return false;
    if (platforms.size && !platforms.has(item.platform)) return false;
    if (access.size && !access.has(item.data_access)) return false;
    if (years) {
      const year = Number(item.aquisition_year);
      const from = years[0] <= ACQUISITION_YEAR_FLOOR ? 0 : years[0];
      if (!year || !inRange(year, [from, years[1]])) return false;
    }
    if (months) {
      const month = Number(item.aquisition_month);
      if (!month || !inRange(month, months)) return false;
    }
    if (gsdCm && (item.gsd_cm == null || !withinGsd(item.gsd_cm, gsdCm))) return false;
    if (uploaded) {
      const day = uploadDay(item.created_at);
      if (day < uploaded[0] || day > uploaded[1]) return false;
    }
    return true;
  };
}

export const toggleChipFilter = (
  filters: ArchiveFilters,
  key: ArchiveChipFilter,
  value: string,
): ArchiveFilters => {
  if (!value) return filters;
  const current = filters[key];
  return {
    ...filters,
    [key]: current.includes(value) ? current.filter((v) => v !== value) : [...current, value],
  };
};

export interface ActiveArchiveFilter {
  id: string;
  label: string;
  clear: (filters: ArchiveFilters) => ArchiveFilters;
}

const formatGsd = ([from, to]: [number, number]) => {
  const open = to >= GSD_STOPS_CM[GSD_STOPS_CM.length - 1];
  if (from <= 0) return open ? "Any resolution" : `≤ ${to} cm/px`;
  return open ? `≥ ${from} cm/px` : `${from}–${to} cm/px`;
};

const formatRange = ([from, to]: [number | string, number | string]) =>
  from === to ? String(from) : `${from}–${to}`;

/** Removable chips for the filters in effect, in the order the modal shows them. */
export function describeActiveFilters(filters: ArchiveFilters): ActiveArchiveFilter[] {
  const listChips = (
    key: ArchiveChipFilter | "platforms",
    label: (value: string) => string,
  ): ActiveArchiveFilter[] =>
    filters[key].map((value) => ({
      id: `${key}:${value}`,
      label: label(value),
      clear: (f) => ({ ...f, [key]: f[key].filter((v) => v !== value) }),
    }));

  const chips: ActiveArchiveFilter[] = [
    ...listChips("authors", (v) => v),
    ...listChips("places", (v) => v),
    ...listChips("countries", (v) => v),
    ...listChips("biomes", (v) => v),
    ...listChips("platforms", (v) => v.charAt(0).toUpperCase() + v.slice(1)),
    ...filters.access.map((value) => ({
      id: `access:${value}`,
      label: accessLabel(value),
      clear: (f: ArchiveFilters) => ({ ...f, access: f.access.filter((v) => v !== value) }),
    })),
  ];
  if (filters.years) {
    const [from, to] = filters.years;
    const label = from <= ACQUISITION_YEAR_FLOOR ? `Until ${to}` : formatRange(filters.years);
    chips.push({ id: "years", label, clear: (f) => ({ ...f, years: null }) });
  }
  if (filters.months) {
    const [from, to] = filters.months;
    chips.push({
      id: "months",
      label: formatRange([MONTH_LABELS[from - 1], MONTH_LABELS[to - 1]]),
      clear: (f) => ({ ...f, months: null }),
    });
  }
  if (filters.gsdCm) {
    chips.push({ id: "gsdCm", label: formatGsd(filters.gsdCm), clear: (f) => ({ ...f, gsdCm: null }) });
  }
  if (filters.uploaded) {
    chips.push({
      id: "uploaded",
      label: `Uploaded ${formatRange(filters.uploaded)}`,
      clear: (f) => ({ ...f, uploaded: null }),
    });
  }
  return chips;
}
