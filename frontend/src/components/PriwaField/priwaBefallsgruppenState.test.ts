import { describe, expect, it } from "vitest";

import {
  arePriwaBefallsgruppenReady,
  groupsForPriwaMosaicMatching,
  indexPriwaBefallsgruppenByTreeId,
  indexConfirmedPriwaFlightLabelsByTreeId,
  resolveInitialFlightGroupDraft,
} from "./priwaBefallsgruppenState";
import type { IPriwaBefallsgruppe } from "./types";
import type { IPriwaMosaic } from "./usePriwaMosaics";

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

const mosaics: IPriwaMosaic[] = [
  {
    id: "10512",
    projectId: "project-1",
    label: "north-flight.zip",
    cogUrl: "10512_cog.tif",
    bbox: null,
    captureDate: "2026-07-15",
    createdAt: "2026-07-15T08:00:00.000Z",
    authors: [],
    additionalInformation: null,
    flightType: "umfeldbefliegung",
  },
  {
    id: "10513",
    projectId: "project-1",
    label: "pending-flight.zip",
    cogUrl: "10513_cog.tif",
    bbox: null,
    captureDate: "2026-07-15",
    createdAt: "2026-07-15T09:00:00.000Z",
    authors: [],
    additionalInformation: null,
    flightType: null,
  },
  {
    id: "10514",
    projectId: "project-1",
    label: "excluded-flight.zip",
    cogUrl: "10514_cog.tif",
    bbox: null,
    captureDate: "2026-07-15",
    createdAt: "2026-07-15T10:00:00.000Z",
    authors: [],
    additionalInformation: null,
    flightType: "not_priwa",
  },
];

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

  it("indexes confirmed groups for tree table and list presentation", () => {
    expect(indexPriwaBefallsgruppenByTreeId([group])).toEqual({
      "tree-1": group,
    });
  });

  it("indexes assigned flight filenames for every tree in a confirmed group", () => {
    expect(
      indexConfirmedPriwaFlightLabelsByTreeId(
        [
          {
            ...group,
            treeIds: ["tree-1", "tree-2"],
            datasetIds: ["10512", "10512", "10513", "10514", "missing"],
          },
        ],
        mosaics,
      ),
    ).toEqual({
      "tree-1": ["north-flight.zip"],
      "tree-2": ["north-flight.zip"],
    });
  });

  it("retains a preselected flight until confirmed groups finish loading", () => {
    const whileLoading = resolveInitialFlightGroupDraft(
      null,
      "10512",
      1,
      false,
    );
    expect(whileLoading).toBeNull();

    expect(
      resolveInitialFlightGroupDraft(whileLoading, "10512", 1, true),
    ).toEqual({
      name: "Befallsgruppe 2",
      origin: "manual",
      treeIds: [],
      datasetIds: ["10512"],
    });
  });
});
