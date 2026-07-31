import { describe, expect, it } from "vitest";

import type { IPriwaBefallsgruppe, IPriwaPoint } from "./types";
import { createPriwaBefallsgruppeFeature } from "./createPriwaBefallsgruppeLayer";

const point = (id: string, lon: number): IPriwaPoint => ({
  id,
  lat: 48.45,
  lon,
  baumnr: id,
  fund: "ja",
  baumart: "Fichte",
  bm: "ja",
  bohrloch: "ja",
  harz: "nein",
  grueneNadelnAmBoden: "nein",
  nadel: "grün",
  rinde: "0%",
  kv: "0%",
  name: "andere",
  datum: "2026-07-30",
  kom: "",
  capturedAt: "2026-07-30T08:00:00.000Z",
  coordinateSource: "qr",
  gps: "ja",
});

const group: IPriwaBefallsgruppe = {
  id: "group-1",
  projectId: "project-1",
  name: "Befallsgruppe Nord",
  origin: "manual",
  confidence: null,
  suggestionReason: null,
  algorithmVersion: null,
  treeIds: ["tree-1", "tree-2"],
  datasetIds: [],
  createdAt: "2026-07-30T08:00:00.000Z",
  updatedAt: "2026-07-30T08:00:00.000Z",
};

describe("createPriwaBefallsgruppeFeature", () => {
  it("renders a one-tree group as a buffered area", () => {
    const feature = createPriwaBefallsgruppeFeature(
      { ...group, treeIds: ["tree-1"] },
      [point("tree-1", 8.15)],
    );

    expect(feature?.getGeometry()?.getType()).toBe("Polygon");
    expect(feature?.get("treeIds")).toEqual(["tree-1"]);
  });

  it("dissolves 15 metre tree buffers into one labelled group geometry", () => {
    const feature = createPriwaBefallsgruppeFeature(group, [
      point("tree-1", 8.15),
      point("tree-2", 8.1502),
    ]);

    expect(feature).not.toBeNull();
    expect(["Polygon", "MultiPolygon"]).toContain(
      feature?.getGeometry()?.getType(),
    );
    expect(feature?.get("groupId")).toBe("group-1");
    expect(feature?.get("groupName")).toBe("Befallsgruppe Nord");
    expect(feature?.get("treeIds")).toEqual(["tree-1", "tree-2"]);
  });
});
