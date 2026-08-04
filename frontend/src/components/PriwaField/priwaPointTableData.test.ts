import { describe, expect, it } from "vitest";

import type { IPriwaBefallsgruppe, IPriwaPoint } from "./types";
import {
  comparePriwaTableText,
  filterPriwaPointsBySearch,
} from "./priwaPointTableData";

const createPoint = (overrides: Partial<IPriwaPoint>): IPriwaPoint => ({
  id: "tree-1",
  baumnr: "4202",
  fund: "ja",
  baumart: "Fichte",
  bm: "ja",
  bohrloch: "ja",
  harz: "nein",
  grueneNadelnAmBoden: "nein",
  nadel: "rot/braun",
  rinde: "0%",
  kv: "bis25%",
  name: "Tobias Merz",
  datum: "2026-06-17",
  kom: "Am Forstweg",
  capturedAt: "2026-06-17T10:00:00Z",
  coordinateSource: "qr",
  gps: "ja",
  lat: 48.1,
  lon: 8.2,
  ...overrides,
});

const group: IPriwaBefallsgruppe = {
  id: "group-1",
  projectId: "priwa",
  name: "Befallsgruppe Nord",
  origin: "manual",
  confidence: null,
  suggestionReason: null,
  algorithmVersion: null,
  treeIds: ["tree-1"],
  datasetIds: ["flight-1"],
  createdAt: "2026-06-18T10:00:00Z",
  updatedAt: "2026-06-18T10:00:00Z",
};

describe("filterPriwaPointsBySearch", () => {
  const firstPoint = createPoint({});
  const secondPoint = createPoint({
    id: "tree-2",
    baumnr: "56010",
    name: "Fabian Bohnert",
    kom: "Südhang",
  });
  const points = [firstPoint, secondPoint];
  const groups = { "tree-1": group };
  const flights = { "tree-1": ["DJI_20260618_Nord.zip"] };

  it("matches tree data, confirmed groups, and flight filenames", () => {
    expect(
      filterPriwaPointsBySearch(points, "4202 Tobias", "all", groups, flights),
    ).toEqual([firstPoint]);
    expect(
      filterPriwaPointsBySearch(
        points,
        "gruppe nord",
        "group",
        groups,
        flights,
      ),
    ).toEqual([firstPoint]);
    expect(
      filterPriwaPointsBySearch(
        points,
        "DJI_20260618",
        "flight",
        groups,
        flights,
      ),
    ).toEqual([firstPoint]);
  });

  it("restricts matches to the selected attribute", () => {
    expect(
      filterPriwaPointsBySearch(points, "Tobias", "name", groups, flights),
    ).toEqual([firstPoint]);
    expect(
      filterPriwaPointsBySearch(points, "Fichte", "name", groups, flights),
    ).toEqual([]);
  });

  it("returns all points for an empty search and none for an unknown term", () => {
    expect(
      filterPriwaPointsBySearch(points, "  ", "all", groups, flights),
    ).toBe(points);
    expect(
      filterPriwaPointsBySearch(points, "unbekannt", "all", groups, flights),
    ).toEqual([]);
  });
});

describe("comparePriwaTableText", () => {
  it("sorts tree numbers naturally and text without case sensitivity", () => {
    expect(comparePriwaTableText("10", "2")).toBeGreaterThan(0);
    expect(comparePriwaTableText("fichte", "Fichte")).toBe(0);
  });
});
