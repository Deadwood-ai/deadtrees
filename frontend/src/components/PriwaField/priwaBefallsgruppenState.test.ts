import { describe, expect, it } from "vitest";

import {
  arePriwaBefallsgruppenReady,
  groupsForPriwaMosaicMatching,
} from "./priwaBefallsgruppenState";
import type { IPriwaBefallsgruppe } from "./types";

const group: IPriwaBefallsgruppe = {
  id: "group-1",
  projectId: "project-1",
  name: "Confirmed",
  origin: "manual",
  confidence: null,
  suggestionReason: null,
  algorithmVersion: null,
  treeIds: ["tree-1"],
  datasetIds: ["10512"],
  createdAt: "2026-07-16T08:00:00.000Z",
  updatedAt: "2026-07-16T08:00:00.000Z",
};

describe("PRIWA Befallsgruppen availability", () => {
  it("allows confirmed-group behavior only after a successful load", () => {
    expect(arePriwaBefallsgruppenReady(false, null)).toBe(true);
    expect(arePriwaBefallsgruppenReady(true, null)).toBe(false);
    expect(arePriwaBefallsgruppenReady(false, "network error")).toBe(false);
  });

  it("falls back to heuristic mosaic matching while groups are unavailable", () => {
    expect(groupsForPriwaMosaicMatching([group], true, null)).toEqual([]);
    expect(
      groupsForPriwaMosaicMatching([group], false, "network error"),
    ).toEqual([]);
    expect(groupsForPriwaMosaicMatching([group], false, null)).toEqual([group]);
  });
});
