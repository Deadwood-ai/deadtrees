import { describe, expect, it } from "vitest";

import { IDataAccess } from "../types/dataset";
import {
  EMPTY_ARCHIVE_FILTERS,
  createArchiveFilter,
  describeActiveFilters,
  toggleChipFilter,
  type ArchiveFilterable,
  type ArchiveFilters,
} from "./datasetArchiveFilters";

const item = (overrides: Partial<ArchiveFilterable> = {}): ArchiveFilterable => ({
  authors: ["Ana Example", "Bo Sample"],
  admin_level_1: "Germany",
  admin_level_2: "Baden-Württemberg",
  admin_level_3: "Freiburg",
  biome_name: "Temperate Broadleaf and Mixed Forests",
  platform: "drone",
  data_access: IDataAccess.public,
  aquisition_year: "2022",
  aquisition_month: "7",
  created_at: "2024-03-05T10:00:00+00:00",
  gsd_cm: 2.4,
  ...overrides,
});

const matches = (patch: Partial<ArchiveFilters>, dataset = item()) =>
  createArchiveFilter({ ...EMPTY_ARCHIVE_FILTERS, ...patch })(dataset);

describe("archive filters", () => {
  it("keeps every dataset, including ones with missing values, when no filter is set", () => {
    expect(
      matches({}, item({ aquisition_month: "", gsd_cm: null, admin_level_1: null, biome_name: null })),
    ).toBe(true);
  });

  it("combines filters of different kinds with AND and values of one kind with OR", () => {
    expect(matches({ authors: ["Bo Sample", "Other"], countries: ["Germany"] })).toBe(true);
    expect(matches({ authors: ["Bo Sample"], countries: ["France"] })).toBe(false);
    expect(matches({ platforms: ["airborne", "drone"] })).toBe(true);
    expect(matches({ access: [IDataAccess.viewonly] })).toBe(false);
  });

  it("filters a range of acquisition months and drops datasets without a month", () => {
    expect(matches({ months: [6, 8] })).toBe(true);
    expect(matches({ months: [9, 12] })).toBe(false);
    expect(matches({ months: [6, 8] }, item({ aquisition_month: "" }))).toBe(false);
  });

  it("keeps datasets older than the first slider year while the lower handle sits there", () => {
    expect(matches({ years: [2010, 2020] }, item({ aquisition_year: "2004" }))).toBe(true);
    expect(matches({ years: [2015, 2020] }, item({ aquisition_year: "2012" }))).toBe(false);
    expect(matches({ years: [2015, 2022] })).toBe(true);
  });

  it("treats the top resolution stop as open-ended", () => {
    expect(matches({ gsdCm: [0, 3] })).toBe(true);
    expect(matches({ gsdCm: [3, 50] })).toBe(false);
    expect(matches({ gsdCm: [20, 50] }, item({ gsd_cm: 120 }))).toBe(true);
    expect(matches({ gsdCm: [0, 50] }, item({ gsd_cm: null }))).toBe(false);
  });

  it("filters upload dates inclusively by day", () => {
    expect(matches({ uploaded: ["2024-03-05", "2024-03-05"] })).toBe(true);
    expect(matches({ uploaded: ["2024-03-06", "2024-12-31"] })).toBe(false);
  });

  it("matches a place chip on the district when the municipality is missing", () => {
    expect(matches({ places: ["Baden-Württemberg"] }, item({ admin_level_3: null }))).toBe(true);
  });

  it("toggles a list chip on and off and describes it as a removable filter", () => {
    const on = toggleChipFilter(EMPTY_ARCHIVE_FILTERS, "authors", "Ana Example");
    expect(on.authors).toEqual(["Ana Example"]);
    expect(toggleChipFilter(on, "authors", "Ana Example").authors).toEqual([]);

    const filters: ArchiveFilters = { ...on, countries: ["Germany"], months: [6, 8], gsdCm: [0, 3] };
    const chips = describeActiveFilters(filters);
    expect(chips.map((chip) => chip.label)).toEqual(["Ana Example", "Germany", "Jun–Aug", "≤ 3 cm/px"]);
    expect(chips[1].clear(filters).countries).toEqual([]);
    expect(chips[1].clear(filters).authors).toEqual(["Ana Example"]);
  });
});
