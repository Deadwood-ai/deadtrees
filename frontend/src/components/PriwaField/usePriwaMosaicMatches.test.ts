import { describe, expect, it } from "vitest";

import { groupsForPriwaMosaicMatching } from "./priwaBefallsgruppenState";
import type { IPriwaBefallsgruppe, IPriwaPoint } from "./types";
import { buildPriwaMosaicMatchIndex } from "./usePriwaMosaicMatches";
import type { IPriwaMosaic } from "./usePriwaMosaics";

const point: IPriwaPoint = {
  id: "tree-1",
  lat: 48.45,
  lon: 8.15,
  baumnr: "1",
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
  datum: "2026-07-10",
  kom: "",
  capturedAt: "2026-07-10T08:00:00.000Z",
  coordinateSource: "qr",
  gps: "ja",
};
const mosaic: IPriwaMosaic = {
  id: "10512",
  projectId: "project-1",
  label: "Flight",
  cogUrl: "flight.tif",
  bbox: "BOX(8.1 48.4,8.2 48.5)",
  captureDate: "2026-07-12",
  createdAt: "2026-07-12T12:00:00.000Z",
  authors: [],
  additionalInformation: null,
};
const group = (datasetIds: string[]): IPriwaBefallsgruppe => ({
  id: "group-1",
  projectId: "project-1",
  name: "Confirmed",
  origin: "manual",
  confidence: null,
  suggestionReason: null,
  algorithmVersion: null,
  treeIds: [point.id],
  datasetIds,
  createdAt: "2026-07-16T08:00:00.000Z",
  updatedAt: "2026-07-16T08:00:00.000Z",
});

describe("buildPriwaMosaicMatchIndex with confirmed groups", () => {
  it("uses explicit group flight links instead of the heuristic", () => {
    const result = buildPriwaMosaicMatchIndex(
      [point],
      [mosaic],
      [group([mosaic.id])],
    );

    expect(result.matchedMosaics).toHaveLength(1);
    expect(result.matchedMosaics[0].points[0].source).toBe("confirmed");
    expect(result.mosaicIdByPointId).toEqual({ "tree-1": "10512" });
  });

  it("respects a confirmed group with deliberately no flight link", () => {
    const result = buildPriwaMosaicMatchIndex([point], [mosaic], [group([])]);

    expect(result.matchedMosaics).toEqual([]);
    expect(result.mosaicIdByPointId).toEqual({});
  });

  it("keeps automatic matches when confirmed groups fail to load", () => {
    const groups = groupsForPriwaMosaicMatching(
      [group([mosaic.id])],
      false,
      "network error",
    );
    const result = buildPriwaMosaicMatchIndex([point], [mosaic], groups);

    expect(result.matchedMosaics).toHaveLength(1);
    expect(result.matchedMosaics[0].points[0].source).toBe("suggestion");
    expect(result.mosaicIdByPointId).toEqual({ "tree-1": "10512" });
  });
});
