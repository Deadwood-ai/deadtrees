import { describe, expect, it } from "vitest";

import { createPriwaBefallsgruppeLayer } from "./createPriwaBefallsgruppeLayer";
import { createPriwaMosaicFootprintLayer } from "./createPriwaMosaicFootprintLayer";
import type { IPriwaBefallsgruppe, IPriwaPoint } from "./types";
import {
  syncPriwaBefallsgruppeLayer,
  syncPriwaMosaicFootprintLayer,
} from "./usePriwaReviewMapLayers";
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
const group: IPriwaBefallsgruppe = {
  id: "group-1",
  projectId: "project-1",
  name: "Befallsgruppe Nord",
  origin: "manual",
  confidence: null,
  suggestionReason: null,
  algorithmVersion: null,
  treeIds: [point.id],
  datasetIds: ["10512"],
  createdAt: "2026-07-10T08:00:00.000Z",
  updatedAt: "2026-07-10T08:00:00.000Z",
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
  flightType: "umfeldbefliegung",
};
describe("PRIWA review map-layer synchronization", () => {
  it("replaces stale Befallsgruppe features with the current group state", () => {
    const source = createPriwaBefallsgruppeLayer().getSource()!;
    syncPriwaBefallsgruppeLayer(source, [group], [point]);
    expect(
      source.getFeatures().map((feature) => feature.get("groupId")),
    ).toEqual(["group-1"]);

    syncPriwaBefallsgruppeLayer(source, [], [point]);
    expect(source.getFeatures()).toEqual([]);
  });

  it("keeps requested footprints and applies selected and visibility state", () => {
    const source = createPriwaMosaicFootprintLayer().getSource()!;
    syncPriwaMosaicFootprintLayer(
      source,
      [mosaic],
      [mosaic],
      new Set([mosaic.id]),
      mosaic.id,
    );

    const features = source.getFeatures();
    expect(features).toHaveLength(1);
    expect(features[0].get("mosaicId")).toBe(mosaic.id);
    expect(features[0].getStyle()).toHaveLength(2);

    syncPriwaMosaicFootprintLayer(
      source,
      [mosaic],
      [mosaic],
      new Set([mosaic.id]),
      mosaic.id,
      false,
    );
    expect(source.getFeatures()).toEqual([]);
  });
});
